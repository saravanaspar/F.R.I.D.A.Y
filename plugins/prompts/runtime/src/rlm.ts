import { FRIDAY_OPERATING_DOCTRINE } from "./orchestrator.js";
import { renderPromptSections } from "./provenance.js";
import type { ChildAgentDoctrineOptions, PromptSection, RlmPromptOptions } from "./types.js";

const IPYTHON_CONTROL_PROMPT = [
  "IPython is the agent's long-lived notebook: a persistent control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Use it to keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns or compaction.",
  "",
  "Do not assume IPython is the native runtime of the external thing being investigated. Evaluate repositories, packages, services, datasets, papers, websites, benchmarks, and APIs through their own normal interfaces, then use IPython to coordinate the process and analyze what comes back.",
  "",
  "When running shell commands from IPython, use `%%bash` cells. If you use `%%bash`, it must be the first line of the code cell. Avoid `!cmd` shell escapes for project commands so shell behavior is explicit and multi-line commands share one shell context.",
  "",
  "Do not install dependencies into the IPython kernel just to make an external project run there. Use that project's documented environment and commands for its own tests, scripts, CLIs, and dependency checks.",
  "",
  "Use Python for reading, searching, and editing files when it helps preserve reusable intermediate state. Assign read/search results to named variables so you can revisit them later.",
  "When an existing FRIDAY tool would require many awkward calls for a local computation, transformation, parser, search, or other one-off operation, prefer writing a small helper function/class directly in IPython. Treat these helpers as notebook scratch code, not as permanent FRIDAY tools or capabilities.",
  "",
  "Each `%%bash` cell runs in a throw-away subshell, so shell-level state does not carry to later cells. Keep dependent shell steps inside one cell, or use kernel-level `%cd` and `os.environ`/`%env` state that survives across calls.",
  "",
  "Python state in the kernel persists across cells: named variables, helper functions, classes, imports, notes, parsed outputs, and helper data structures remain available in later turns.",
  "Reuse useful kernel state across turns. When stale state, incompatible imports, excessive notebook state, or reproducibility makes a clean process preferable, set `fresh=true` on the next `ipython` call; that discards the old kernel before executing the supplied code in a new one.",
  "",
  "Never start a persistent server, watcher, daemon, or other long-running background service from IPython or the foreground Bash tool. Use the managed process tool when it is available so FRIDAY can own and clean up that process at the end of the agent run.",
].join("\n");

export interface RlmPromptPlan {
  /** Complete prompt visible to the model. */
  prompt: string;
  /** Stable leading bytes safe to reuse as a provider prompt-cache prefix. */
  stablePrefix: string;
  /** Session-specific suffix kept outside the stable prefix. */
  volatileSuffix: string;
}

export function buildChildAgentDoctrine(options: ChildAgentDoctrineOptions): string | undefined {
  const depth = options.depth ?? 0;
  const hasIpython = options.activeTools === undefined || options.activeTools.includes("ipython");
  const hasAgentMessage = options.installedSkills?.includes("agent_message") ?? false;
  if (depth <= 0) return undefined;

  const lines = [
    `You are a child agent spawned by ${options.parentAgent ?? "your parent agent"}. Task prompts are labeled \`[task from parent]\`.`,
  ];
  if (hasAgentMessage && hasIpython) {
    lines.push(
      'When a task calls for an answer, reply explicitly with `await agent_message.send(message, receiver_role="parent")`. Not every message or task needs a reply; continue cleanup after sending and go idle normally.',
    );
  }
  return lines.join("\n");
}

/**
 * Build the RLM prompt while keeping per-session metadata at the tail.
 *
 * The stable/volatile split is request metadata only; the model still receives
 * one ordinary system prompt. Provider adapters may split the stable prefix
 * into a cacheable wire block without changing persisted Agent state.
 */
export function buildRlmPromptPlan(options: RlmPromptOptions): RlmPromptPlan {
  const installedSkills = options.installedSkills ?? [];
  const hasAgentMessage = installedSkills.includes("agent_message");
  const hasAgentObserve = installedSkills.includes("agent_observe");
  const allowRecursion = options.allowRecursion ?? true;
  const depth = options.depth ?? 0;
  const activeTools = options.activeTools ?? [];
  const hasIpython = options.activeTools === undefined ? true : activeTools.includes("ipython");

  const stableSections: PromptSection[] = [{
    id: "friday-operating-doctrine",
    authority: "core-policy",
    cache: "stable",
    content: FRIDAY_OPERATING_DOCTRINE,
  }];
  const hostLines: string[] = [];

  if ((options.kernelPackages?.length ?? 0) > 0) {
    hostLines.push(`Pre-installed Python packages: ${options.kernelPackages!.join(", ")}.`);
  }

  if (hasAgentMessage) {
    hostLines.push(
      "Agent messaging is restricted to your parent, siblings, and direct children; deeper communication relays through the intermediate child.",
    );
  }
  if (hasAgentObserve) {
    hostLines.push(
      "Agent observation is restricted to your parent, siblings, and direct children; deeper inspection relays through the intermediate child.",
    );
  }

  if (allowRecursion && hasIpython) {
    hostLines.push(
      "A callable `rlm` is already in your global namespace. `await rlm('sub-task')` spawns a child and returns immediately after task admission with `rlm_child_id`, `name`, `session_dir`, and `model`; it never waits for or returns the child's answer.",
      "Choose a stable child name with `await rlm('sub-task', name='api-reviewer')`; names must be unique among siblings. If omitted, the host generates a readable unique name.",
      "A child inherits your model. If a different model is explicitly requested, use `await rlm.find_models(...)` and an exact returned selector.",
      "For 2–32 independent tasks, prefer `await rlm.gather([...])`: FRIDAY admits them as a bounded concurrent batch and waits for all terminal states. Use `await rlm.spawn_many([...])` plus `await rlm.wait_subagents(handles)` when you need explicit fan-out/fan-in control.",
      "Honor an explicit user request for multiple independent agents when it is safe and meaningful. Otherwise choose the team size from the prompt and decomposition: use parallel children for genuinely independent work, and keep trivial or serial work in the current agent.",
      "The host applies an operator concurrency ceiling and live RAM-aware admission. Queued children are intentional under memory pressure; never bypass that resource gate or replace it with unsafe host execution.",
      "Subagents share the parent project filesystem/workspace unless the host explicitly provides isolation. Parallel research, review, and read-only analysis are safe defaults. For implementation, partition siblings onto disjoint files or logically independent areas; shared-workspace mutating core tools are host-serialized, but the parent still owns integration, conflict resolution, tests, and final verification. Host serialization covers tool invocations, not arbitrary background writers: do not launch watchers, daemons, or background processes that keep mutating the shared project while sibling implementation work is active. Never use project files as an ad-hoc mailbox.",
    );
    if (hasAgentMessage) {
      hostLines.push(
        "Children reply explicitly with `await agent_message.send(message, receiver_role='parent')` when an answer is needed. Use `await rlm.list_subagents()` to recover direct child handles after admission.",
      );
    } else {
      hostLines.push("Use `await rlm.list_subagents()` to recover direct child handles after admission.");
    }
    if (hasAgentObserve) {
      hostLines.push("Use `agent_observe` for bounded inspection of a direct child's rollout.");
    } else {
      hostLines.push("Without an observation capability, collect child results through explicit parent replies when available. Inspect shared project state only when the task itself requires it; project files are not a messaging channel.");
    }
    hostLines.push(
      "Use a single `await rlm(...)` for one detached child; use `rlm.gather` for true bounded concurrent fan-out/fan-in. Delete a direct child explicitly with `await rlm.delete_subagent(child)` when it is no longer needed.",
    );
  }

  if (hasIpython) hostLines.push(IPYTHON_CONTROL_PROMPT);
  if (hostLines.length > 0) {
    stableSections.push({
      id: "rlm-execution-doctrine",
      authority: "host-policy",
      cache: "stable",
      content: hostLines.join("\n\n"),
    });
  }

  const volatileSections: PromptSection[] = [];
  const childDoctrine = buildChildAgentDoctrine(options);
  if (childDoctrine) {
    volatileSections.push({
      id: "child-agent-doctrine",
      authority: "host-policy",
      cache: "volatile",
      content: childDoctrine,
    });
  }
  volatileSections.push({
    id: "rlm-runtime-context",
    authority: "runtime-context",
    cache: "volatile",
    content: [
      `Working directory: ${options.cwd}`,
      `Conversation log: ${options.messagesPath}`,
      `Recursive agent depth: ${depth}`,
    ].join("\n"),
  });

  const stablePrefix = renderPromptSections(stableSections);
  const volatileSuffix = renderPromptSections(volatileSections);
  const prompt = volatileSuffix ? `${stablePrefix}\n\n${volatileSuffix}` : stablePrefix;
  return Object.freeze({ prompt, stablePrefix, volatileSuffix });
}

export function buildRlmPrompt(options: RlmPromptOptions): string {
  return buildRlmPromptPlan(options).prompt;
}

export function buildSubagentGuidance(
  options: { hasAgentMessage?: boolean; hasAgentObserve?: boolean } = {},
): string {
  const lines = [
    "# Delegating to sub-agents",
    "",
    "Spawn one independent, self-contained worker with `handle = await rlm('task', name='worker')`. For parallel work use `children = await rlm.gather([...])`; FRIDAY runs the batch concurrently within the parent concurrency budget and returns terminal child records.",
  ];
  if (options.hasAgentMessage) {
    lines.push(
      "Ask for an explicit reply when needed. A child replies with `await agent_message.send(message, receiver_role='parent')`; parent follow-ups use `receiver_role='child'` plus the child's name or id.",
    );
  }
  lines.push("Use `await rlm.list_subagents()` after kernel restart or compaction.");
  if (options.hasAgentObserve) lines.push("Use `agent_observe` for bounded transcript inspection.");
  lines.push(
    "Subagents share the parent project filesystem/workspace unless the host explicitly provides isolation. Parallel research, review, and read-only analysis are safe defaults. For implementation, assign siblings disjoint files or serialize edits; never let sibling agents concurrently edit the same file. Host serialization does not make arbitrary mutating background processes safe, so do not launch them during sibling implementation work. Never use project files as an ad-hoc mailbox.",
    "Delegate parallel context-heavy research or carefully partitioned implementation; do a single known lookup, edit, or command inline. The parent remains responsible for integration, conflict resolution, tests, and final verification.",
  );
  return lines.join("\n");
}
