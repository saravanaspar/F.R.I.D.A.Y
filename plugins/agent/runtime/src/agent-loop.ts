/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import { reportOperationalError, reportUnlessExpectedAbort } from "@friday/operational-errors";
import { EventStream } from "./event-stream.js";
import { streamSimple, validateToolArguments } from "./model-access.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	ToolResultMessage,
} from "./model-types.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";
import {
	modelRetryDelayMs,
	modelRetryFailure,
	retryableModelFailure,
	waitForModelRetry,
} from "./retry.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const ABORT_ERROR_MESSAGE = "Request was aborted";
const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAbortError(): Error {
	return new Error(ABORT_ERROR_MESSAGE);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return operation;
	}
	if (signal.aborted) {
		onAbort?.();
		void operation.catch((error: unknown) => {
			reportUnlessExpectedAbort({ component: "agent", operation: "settle operation after abort", error }, signal);
		});
		return Promise.reject(createAbortError());
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
		};
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function maybePromiseWithAbort<T>(
	operation: T | Promise<T>,
	signal: AbortSignal | undefined,
	onAbort?: () => void,
): Promise<T> {
	return raceWithAbort(Promise.resolve(operation), signal, onAbort);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.message === ABORT_ERROR_MESSAGE || error.name === "AbortError");
}

type PostTurnResult<T> = { status: "completed"; value: T } | { status: "aborted" };

async function settlePostTurn<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<PostTurnResult<T>> {
	try {
		return { status: "completed", value: await operation };
	} catch (error) {
		if (signal?.aborted && isAbortError(error)) {
			return { status: "aborted" };
		}
		throw error;
	}
}

function cloneAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
	return content.map((part) => {
		if (part.type === "toolCall") {
			return { ...part, arguments: { ...part.arguments } };
		}
		return { ...part };
	});
}

function cloneUsage(usage: AssistantMessage["usage"]): AssistantMessage["usage"] {
	return { ...usage, cost: { ...usage.cost } };
}

function createAbortedAssistantMessage(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
): AssistantMessage {
	return {
		role: "assistant",
		content: partialMessage ? cloneAssistantContent(partialMessage.content) : [{ type: "text", text: "" }],
		api: partialMessage?.api ?? config.model.api,
		provider: partialMessage?.provider ?? config.model.provider,
		model: partialMessage?.model ?? config.model.id,
		usage: cloneUsage(partialMessage?.usage ?? EMPTY_USAGE),
		stopReason: "aborted",
		errorMessage: ABORT_ERROR_MESSAGE,
		timestamp: Date.now(),
	};
}

function getTerminalMessage(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>): AssistantMessage {
	return event.type === "done" ? event.message : event.error;
}

function endAgentStreamOnError(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	promise: Promise<AgentMessage[]>,
): void {
	void promise.then(
		(messages) => {
			stream.end(messages);
		},
		() => {
			stream.end([]);
		},
	);
}

async function pollMessagesUnlessAborted(
	poll: (() => AgentMessage[] | Promise<AgentMessage[]>) | undefined,
	signal: AbortSignal | undefined,
): Promise<AgentMessage[]> {
	if (!poll || signal?.aborted) {
		return [];
	}
	return (await maybePromiseWithAbort(poll(), signal)) || [];
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	endAgentStreamOnError(
		stream,
		runAgentLoop(
			prompts,
			context,
			config,
			async (event) => {
				stream.push(event);
			},
			signal,
			streamFn,
		),
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	endAgentStreamOnError(
		stream,
		runAgentLoopContinue(
			context,
			config,
			async (event) => {
				stream.push(event);
			},
			signal,
			streamFn,
		),
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let lastTurn: Parameters<NonNullable<AgentLoopConfig["getContinuationMessages"]>>[0] | undefined;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = await pollMessagesUnlessAborted(config.getSteeringMessages, signal);

	const shouldStopBeforeTurn = (): boolean => !firstTurn && (config.shouldStopBeforeTurn?.() ?? false);

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		throwIfAborted(signal);
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			throwIfAborted(signal);
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			if (signal?.aborted) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			lastTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};

			const shouldStopResult = await settlePostTurn(
				maybePromiseWithAbort(
					config.shouldStopAfterTurn?.({
						message,
						toolResults,
						context: currentContext,
						newMessages,
					}) ?? false,
					signal,
				),
				signal,
			);
			if (shouldStopResult.status === "aborted") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			if (shouldStopResult.value || shouldStopBeforeTurn()) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const steeringMessagesResult = await settlePostTurn(
				pollMessagesUnlessAborted(config.getSteeringMessages, signal),
				signal,
			);
			if (steeringMessagesResult.status === "aborted") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			pendingMessages = steeringMessagesResult.value;
			// Steering drained by this poll owns the turn boundary; stop only when it was empty.
			if (pendingMessages.length === 0 && shouldStopBeforeTurn()) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		if (shouldStopBeforeTurn()) break;
		const followUpMessagesResult = await settlePostTurn(
			pollMessagesUnlessAborted(config.getFollowUpMessages, signal),
			signal,
		);
		if (followUpMessagesResult.status === "aborted") {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		const followUpMessages = followUpMessagesResult.value;
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		if (shouldStopBeforeTurn()) break;
		const continuationMessagesResult = lastTurn
			? await settlePostTurn(
					maybePromiseWithAbort(config.getContinuationMessages?.(lastTurn, signal) ?? [], signal),
					signal,
				)
			: ({ status: "completed", value: [] } satisfies PostTurnResult<AgentMessage[]>);
		if (continuationMessagesResult.status === "aborted") {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		const continuationMessages = continuationMessagesResult.value || [];
		if (continuationMessages.length > 0) {
			pendingMessages = continuationMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	const maxRetries = Math.max(0, Math.min(100, Math.floor(config.modelRetryMaxRetries ?? 0)));

	retryLoop: for (let retriesUsed = 0; ; retriesUsed += 1) {
		let partialMessage: AssistantMessage | null = null;
		let addedPartial = false;
		let providerResponse: import("./model-types.js").ProviderResponse | undefined;
		let hostHookFailure: { readonly error: unknown } | undefined;

		const removeRetryPartial = () => {
			if (addedPartial && context.messages.length > 0) context.messages.pop();
			partialMessage = null;
			addedPartial = false;
		};

		const finishAbortedMessage = async () => {
			const finalMessage = createAbortedAssistantMessage(config, partialMessage);
			if (addedPartial) {
				context.messages[context.messages.length - 1] = finalMessage;
			} else {
				context.messages.push(finalMessage);
				await emit({ type: "message_start", message: { ...finalMessage } });
			}
			await emit({ type: "message_end", message: finalMessage });
			return finalMessage;
		};

		const retryIfAllowed = async (error: unknown): Promise<boolean> => {
			if (retriesUsed >= maxRetries) return false;
			const failure = modelRetryFailure(error, providerResponse);
			const retry = retryableModelFailure(failure);
			if (!retry) return false;
			removeRetryPartial();
			const attempt = retriesUsed + 1;
			const delayMs = modelRetryDelayMs(attempt, failure);
			await emit({ type: "model_retry", attempt, maxRetries, delayMs, message: retry.message });
			await waitForModelRetry(delayMs, signal);
			return true;
		};

		const handleProviderFailure = async (
			error: unknown,
		): Promise<{ readonly kind: "retry" } | { readonly kind: "aborted"; readonly message: AssistantMessage }> => {
			// Payload/response callbacks are host hooks, not part of the provider boundary. Preserve their
			// original failure and never turn it into another billable model request.
			if (hostHookFailure) throw hostHookFailure.error;
			if (signal?.aborted && isAbortError(error)) {
				return { kind: "aborted", message: await finishAbortedMessage() };
			}
			if (await retryIfAllowed(error)) return { kind: "retry" };
			throw error;
		};

		let messages: AgentMessage[];
		let llmMessages: Message[];
		let resolvedApiKey: string | undefined;
		try {
			throwIfAborted(signal);
			messages = context.messages;
			if (config.transformContext) {
				messages = await maybePromiseWithAbort(config.transformContext(messages, signal), signal);
			}
			llmMessages = await maybePromiseWithAbort(config.convertToLlm(messages), signal);
			resolvedApiKey =
				(config.getApiKey
					? await maybePromiseWithAbort(config.getApiKey(config.model.provider), signal)
					: undefined) || config.apiKey;
		} catch (error) {
			if (signal?.aborted && isAbortError(error)) return finishAbortedMessage();
			throw error;
		}

		const streamFunction = streamFn || streamSimple;
		const stableSystemPromptPrefix =
			config.getStableSystemPromptPrefix?.() ?? context.stableSystemPromptPrefix;
		const llmContext: Context = {
			systemPrompt: config.getSystemPrompt?.() ?? context.systemPrompt,
			messages: llmMessages,
			tools: context.tools,
		};
		if (stableSystemPromptPrefix !== undefined) llmContext.stableSystemPromptPrefix = stableSystemPromptPrefix;
		const streamOptions = {
			...config,
			apiKey: resolvedApiKey,
			signal,
			onPayload: async (payload: unknown, model: Model<any>) => {
				try {
					return await config.onPayload?.(payload, model);
				} catch (error) {
					hostHookFailure = { error };
					throw error;
				}
			},
			onResponse: async (incoming: import("./model-types.js").ProviderResponse, model: Model<any>) => {
				providerResponse = incoming;
				try {
					await config.onResponse?.(incoming, model);
				} catch (error) {
					hostHookFailure = { error };
					throw error;
				}
			},
		};

		let response: AssistantMessageEventStream;
		try {
			response = await maybePromiseWithAbort(
				streamFunction(config.model, llmContext, {
					...streamOptions,
				}),
				signal,
			);
		} catch (error) {
			const outcome = await handleProviderFailure(error);
			if (outcome.kind === "retry") continue retryLoop;
			return outcome.message;
		}

		let iterator: AsyncIterator<AssistantMessageEvent>;
		try {
			iterator = response[Symbol.asyncIterator]();
		} catch (error) {
			const outcome = await handleProviderFailure(error);
			if (outcome.kind === "retry") continue retryLoop;
			return outcome.message;
		}
		const closeIterator = () => {
			void Promise.resolve(iterator.return?.()).catch((error: unknown) => {
				reportOperationalError({ component: "agent", operation: "close provider stream iterator", error });
			});
		};
		while (true) {
			let next: IteratorResult<AssistantMessageEvent>;
			try {
				next = await raceWithAbort<IteratorResult<AssistantMessageEvent>>(iterator.next(), signal, closeIterator);
			} catch (error) {
				const outcome = await handleProviderFailure(error);
				if (outcome.kind === "retry") continue retryLoop;
				return outcome.message;
			}
			if (next.done) break;
			const event = next.value;
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;
				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
					}
					break;
				case "done":
				case "error": {
					let finalMessage = getTerminalMessage(event);
					try {
						finalMessage = await maybePromiseWithAbort(response.result(), signal);
					} catch (error) {
						// A terminal event already carries the authoritative response. If an
						// abort wins only the result() race, keep that event instead of replacing
						// a completed response or waiting on a result promise that may never settle.
						if (hostHookFailure || !signal?.aborted || !isAbortError(error)) {
							const outcome = await handleProviderFailure(error);
							if (outcome.kind === "retry") continue retryLoop;
							return outcome.message;
						}
					}
					if (hostHookFailure) throw hostHookFailure.error;
					if (finalMessage.stopReason === "error" && await retryIfAllowed(finalMessage)) continue retryLoop;
					if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
					else context.messages.push(finalMessage);
					if (!addedPartial) await emit({ type: "message_start", message: { ...finalMessage } });
					await emit({ type: "message_end", message: finalMessage });
					return finalMessage;
				}
			}
		}

		let finalMessage: AssistantMessage;
		try {
			finalMessage = await maybePromiseWithAbort(response.result(), signal);
		} catch (error) {
			const outcome = await handleProviderFailure(error);
			if (outcome.kind === "retry") continue retryLoop;
			return outcome.message;
		}
		if (hostHookFailure) throw hostHookFailure.error;
		if (finalMessage.stopReason === "error" && await retryIfAllowed(finalMessage)) continue retryLoop;
		if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
		else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		await emit({ type: "message_end", message: finalMessage });
		return finalMessage;
	}
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		if (signal?.aborted) {
			break;
		}

		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await maybePromiseWithAbort(
				config.beforeToolCall(
					{
						assistantMessage,
						toolCall,
						args: validatedArgs,
						context: currentContext,
					},
					signal,
				),
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		throwIfAborted(signal);
		const result = await raceWithAbort(
			prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
				if (!acceptingUpdates || signal?.aborted) {
					return;
				}
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			}),
			signal,
		);
		acceptingUpdates = false;
		try {
			await raceWithAbort(
				Promise.all(updateEvents).then(() => undefined),
				signal,
			);
		} catch (error) {
			if (!signal?.aborted || !isAbortError(error)) {
				throw error;
			}
		}
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await raceWithAbort(
			Promise.all(updateEvents).then(() => undefined),
			signal,
		).catch((updateError: unknown) => {
			reportUnlessExpectedAbort({ component: "agent", operation: "finish tool update events after failure", error: updateError }, signal);
		});
		return {
			result: createErrorToolResult(
				signal?.aborted ? "Tool execution aborted" : error instanceof Error ? error.message : String(error),
			),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await maybePromiseWithAbort(
				config.afterToolCall(
					{
						assistantMessage,
						toolCall: prepared.toolCall,
						args: prepared.args,
						result,
						isError,
						context: currentContext,
					},
					signal,
				),
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
