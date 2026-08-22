import { type Static, Type } from "typebox";
import { executionAccess, type ShellOperations } from "./execution-access.js";
import { DEFAULT_MAX_TOTAL_BYTES, OutputAccumulator } from "./output-accumulator.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.js";
import type { Tool } from "./types.js";

const DEFAULT_BASH_TIMEOUT_SECONDS = 600;
const MAX_BASH_TIMEOUT_SECONDS = 3600;

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  network: Type.Optional(
    Type.Boolean({ description: "Set true only when this command needs internet access. FRIDAY blocks sandbox networking by default and asks the user to approve network-bearing actions." }),
  ),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_BASH_TIMEOUT_SECONDS, description: `Timeout in seconds (default ${DEFAULT_BASH_TIMEOUT_SECONDS}, max ${MAX_BASH_TIMEOUT_SECONDS})` })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext, input: BashToolInput) => BashSpawnContext | Promise<BashSpawnContext>;

export interface BashToolOptions {
  operations?: ShellOperations;
  commandPrefix?: string;
  shellPath?: string;
  spawnHook?: BashSpawnHook;
}

const BASH_UPDATE_THROTTLE_MS = 100;

async function resolveSpawnContext(
  command: string,
  cwd: string,
  input: BashToolInput,
  spawnHook?: BashSpawnHook,
): Promise<BashSpawnContext> {
  const baseContext: BashSpawnContext = { command, cwd, env: { ...process.env } };
  return spawnHook ? await spawnHook(baseContext, input) : baseContext;
}

export function createBashTool(cwd: string, options?: BashToolOptions): Tool<typeof bashSchema, BashToolDetails | undefined> {
  const operations = options?.operations ?? executionAccess().createLocalShellOperations({ shellPath: options?.shellPath });
  const commandPrefix = options?.commandPrefix;
  const spawnHook = options?.spawnHook;

  return {
    name: "bash",
    label: "bash",
    description: `Execute a foreground bash command in the current working directory and wait for it to finish. Use the process tool for long-running background services. Network is blocked by default. Set \`network: true\` only when needed; FRIDAY then routes the network-bearing action through permission approval, including approval in the originating trusted channel. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; full-output persistence is hard-capped at ${DEFAULT_MAX_TOTAL_BYTES / (1024 * 1024)}MB. The default timeout is ${DEFAULT_BASH_TIMEOUT_SECONDS}s.`,
    parameters: bashSchema,
    async execute(_toolCallId, input, signal, onUpdate) {
      const { command } = input;
      const timeout = input.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS;
      const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
      const spawnContext = await resolveSpawnContext(resolvedCommand, cwd, input, spawnHook);
      const output = new OutputAccumulator({ tempFilePrefix: "friday-bash", maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES });
      const outputAbort = new AbortController();
      const executionSignal = signal ? AbortSignal.any([signal, outputAbort.signal]) : outputAbort.signal;
      let outputLimitExceeded = false;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          },
        });
      };

      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };

      if (onUpdate) onUpdate({ content: [], details: undefined });

      const handleData = (data: Buffer) => {
        if (!output.append(data) && !outputLimitExceeded) {
          outputLimitExceeded = true;
          outputAbort.abort("bash output limit exceeded");
        }
        scheduleOutputUpdate();
      };

      const finishOutput = async () => {
        output.finish();
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
        const truncation = snapshot.truncation;
        let text = snapshot.content || emptyText;
        let details: BashToolDetails | undefined;
        if (truncation.truncated) {
          details = { truncation, fullOutputPath: snapshot.fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }
        return { text, details };
      };

      const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

      try {
        let exitCode: number | null;
        try {
          const result = await operations.exec(spawnContext.command, spawnContext.cwd, {
            onData: handleData,
            signal: executionSignal,
            timeout,
            env: spawnContext.env,
          });
          exitCode = result.exitCode;
        } catch (error) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");
          if (outputLimitExceeded) {
            throw new Error(appendStatus(text, `Command stopped after exceeding the ${formatSize(DEFAULT_MAX_TOTAL_BYTES)} output limit`));
          }
          if (error instanceof Error && error.message === "aborted") {
            throw new Error(appendStatus(text, "Command aborted"));
          }
          if (error instanceof Error && error.message.startsWith("timeout:")) {
            const timeoutSecs = error.message.split(":")[1];
            throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
          }
          throw error;
        }

        const snapshot = await finishOutput();
        const { text, details } = formatOutput(snapshot);
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(appendStatus(text, `Command exited with code ${exitCode}`));
        }
        return { content: [{ type: "text", text }], details };
      } finally {
        clearUpdateTimer();
      }
    },
  };
}
