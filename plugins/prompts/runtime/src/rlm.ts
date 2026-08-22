import type { ChildAgentDoctrineOptions, RlmPromptOptions } from "./types.js";
import { FRIDAY_OPERATING_DOCTRINE } from "./orchestrator.js";

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
  "",
  "Each `%%bash` cell runs in a throw-away subshell, so shell-level state does not carry to later cells. Keep dependent shell steps inside one cell, or use kernel-level `%cd` and `os.environ`/`%env` state that survives across calls.",
  "",
  "Python state in the kernel persists across cells: named variables, helper functions, classes, imports, notes, parsed outputs, and helper data structures remain available in later turns.",
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
  const canRunShellSkills = hasIpython || activeTools.includes("bash");

  const stableParts = [
    FRIDAY_OPERATING_DOCTRINE,
    "",
    `Working directory: ${options.cwd}`,
  ];

  if ((options.kernelPackages?.length ?? 0) > 0) {
    stableParts.push(`Pre-installed Python packages: ${options.kernelPackages!.join(", ")}.`);
  }

  if (installedSkills.length > 0) {
    const installed = installedSkills.map((skill) => `\`${skill}\``).join(", ");
    stableParts.push("");
    if (hasIpython) {
      stableParts.push(`Installed Python skill modules (pre-imported): ${installed}.`);
      stableParts.push(
        "Read each skill's SKILL.md for its API. Inspect a module with `help(<skill>)` or `dir(<skill>)`, then inspect a documented callable with `inspect.signature(<skill>.<function>)`.",
      );
    } else if (canRunShellSkills) {
      stableParts.push(`Installed skills available as shell commands: ${installed}.`);
    }
    if (canRunShellSkills) {
      stableParts.push("When a skill exposes a CLI, discover its usage with `<skill> --help`.");
    }
  }

  if (hasAgentMessage) {
    stableParts.push(
      "Agent messaging is restricted to your parent, siblings, and direct children; deeper communication relays through the intermediate child.",
    );
  }
  if (hasAgentObserve) {
    stableParts.push(
      "Agent observation is restricted to your parent, siblings, and direct children; deeper inspection relays through the intermediate child.",
    );
  }

  if (allowRecursion && hasIpython) {
    stableParts.push(
      "",
      "A callable `rlm` is already in your global namespace. `await rlm('sub-task')` spawns a child and returns immediately after task admission with `rlm_child_id`, `name`, `session_dir`, and `model`; it never waits for or returns the child's answer.",
      "Choose a stable child name with `await rlm('sub-task', name='api-reviewer')`; names must be unique among siblings. If omitted, the host generates a readable unique name.",
      "A child inherits your model. If a different model is explicitly requested, use `await rlm.find_models(...)` and an exact returned selector.",
    );
    if (hasAgentMessage) {
      stableParts.push(
        "Children reply explicitly with `await agent_message.send(message, receiver_role='parent')` when an answer is needed. Use `await rlm.list_subagents()` to recover direct child handles after admission.",
      );
    } else {
      stableParts.push("Use `await rlm.list_subagents()` to recover direct child handles after admission.");
    }
    if (hasAgentObserve) {
      stableParts.push("Use `agent_observe` for bounded inspection of a direct child's rollout.");
    } else {
      stableParts.push("Inspect files a child wrote when you need to collect its work without an observation capability.");
    }
    stableParts.push(
      "Spawn independent children in separate calls and end your turn instead of awaiting completion. Delete a direct child explicitly with `await rlm.delete_subagent(child)` when it is no longer needed.",
    );
  }

  if (hasIpython) stableParts.push("", IPYTHON_CONTROL_PROMPT);

  const volatileParts = [
    `Conversation log: ${options.messagesPath}`,
    `Recursive agent depth: ${depth}`,
  ];
  const childDoctrine = buildChildAgentDoctrine(options);
  if (childDoctrine) volatileParts.push(childDoctrine);

  const stablePrefix = stableParts.join("\n");
  const volatileSuffix = volatileParts.join("\n");
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
    "Spawn independent, self-contained work with `handle = await rlm('task', name='worker')`. This returns at admission, not completion; keep the handle to stop or inspect the child later.",
  ];
  if (options.hasAgentMessage) {
    lines.push(
      "Ask for an explicit reply when needed. A child replies with `await agent_message.send(message, receiver_role='parent')`; parent follow-ups use `receiver_role='child'` plus the child's name or id.",
    );
  }
  lines.push("Use `await rlm.list_subagents()` after kernel restart or compaction.");
  if (options.hasAgentObserve) lines.push("Use `agent_observe` for bounded transcript inspection.");
  lines.push(
    "Have children write files and read those files for fan-in.",
    "Delegate parallel context-heavy research or independent implementation; do a single known lookup, edit, or command inline.",
  );
  return lines.join("\n");
}
