import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import { executionAccess, type ManagedProcessOperations, type ManagedProcessOwner, type ManagedProcessSnapshot } from "./execution-access.js";
import type { Tool } from "./types.js";

const processSchema = Type.Object({
  action: Type.Union([
    Type.Literal("start"),
    Type.Literal("list"),
    Type.Literal("status"),
    Type.Literal("logs"),
    Type.Literal("stop"),
  ]),
  command: Type.Optional(Type.String({ description: "Command to start in the background; required for action=start" })),
  id: Type.Optional(Type.String({ description: "Managed process id; required for status/logs/stop" })),
  network: Type.Optional(Type.Boolean({ description: "Set true only when the background command needs network access. Network-bearing starts always require explicit permission approval, including when the user selected full mode." })),
  maxLifetimeSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Optional lifetime in seconds (1-3600), capped by FRIDAY supervisor policy" })),
});

export type ProcessToolInput = Static<typeof processSchema>;

export interface ProcessStartContext {
  readonly id: string;
  readonly owner: ManagedProcessOwner;
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly launch?: {
    readonly command: string;
    readonly args: readonly string[];
  } | undefined;
  readonly cleanup?: (() => void | Promise<void>) | undefined;
}

export type ProcessStartHook = (
  context: ProcessStartContext,
  input: ProcessToolInput,
) => ProcessStartContext | Promise<ProcessStartContext>;

export interface ProcessToolOptions {
  operations?: ManagedProcessOperations;
  startHook?: ProcessStartHook;
}

function requireId(input: ProcessToolInput): string {
  const id = input.id?.trim();
  if (!id) throw new Error(`process action ${input.action} requires an id`);
  return id;
}

function formatSnapshot(snapshot: ManagedProcessSnapshot): string {
  const status = [
    `id=${snapshot.id}`,
    `state=${snapshot.state}`,
    `started=${snapshot.startedAt}`,
    `output=${snapshot.totalOutputBytes} bytes${snapshot.logsTruncated ? " (tail retained)" : ""}`,
  ];
  if (snapshot.exitCode !== undefined) status.push(`exit=${String(snapshot.exitCode)}`);
  if (snapshot.signal) status.push(`signal=${snapshot.signal}`);
  return status.join(" ");
}

export function createProcessTool(cwd: string, options: ProcessToolOptions = {}): Tool<typeof processSchema> {
  const operations = options.operations ?? executionAccess().managedProcesses;
  return {
    name: "process",
    label: "process",
    description: "Manage explicit background shell processes for the current top-level agent run. Use start for long-running services such as npm run dev, then use bash for immediate commands such as tests or Playwright. Background processes are bounded, supervised, and automatically terminated before the agent run can finish. Subagents cannot start persistent background processes.",
    parameters: processSchema,
    async execute(_toolCallId, input) {
      if (input.action === "start") {
        const command = input.command?.trim();
        if (!command) throw new Error("process action start requires a command");
        const owner = operations.currentOwner();
        if (!owner) throw new Error("Background processes require an active agent run");
        if (owner.ownerKind !== "main-agent") throw new Error("Subagents cannot start persistent background processes");
        const maxLifetimeSeconds = input.maxLifetimeSeconds;
        if (maxLifetimeSeconds !== undefined && (!Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1 || maxLifetimeSeconds > 3600)) {
          throw new Error("maxLifetimeSeconds must be an integer between 1 and 3600");
        }
        const id = `proc-${randomUUID().slice(0, 12)}`;
        const base: ProcessStartContext = { id, owner, command, cwd, env: { ...process.env } };
        const context = options.startHook ? await options.startHook(base, input) : base;
        const snapshot = await operations.start({
          id,
          command: context.command,
          cwd: context.cwd,
          env: context.env,
          ...(context.launch === undefined ? {} : { launch: context.launch }),
          ...(maxLifetimeSeconds === undefined ? {} : { maxLifetimeMs: Math.floor(maxLifetimeSeconds * 1000) }),
          ...(context.cleanup === undefined ? {} : { cleanup: context.cleanup }),
        });
        return { content: [{ type: "text", text: `Started background process. ${formatSnapshot(snapshot)}` }], details: undefined };
      }

      if (input.action === "list") {
        const snapshots = operations.list();
        const text = snapshots.length === 0 ? "No managed background processes for this agent run." : snapshots.map(formatSnapshot).join("\n");
        return { content: [{ type: "text", text }], details: undefined };
      }

      const id = requireId(input);
      if (input.action === "status") {
        const snapshot = operations.get(id);
        if (!snapshot) throw new Error(`Unknown managed process: ${id}`);
        return { content: [{ type: "text", text: formatSnapshot(snapshot) }], details: undefined };
      }
      if (input.action === "logs") {
        const logs = operations.logs(id);
        const prefix = logs.truncated ? `[Showing retained tail of ${logs.totalBytes} total output bytes]\n` : "";
        return { content: [{ type: "text", text: `${prefix}${logs.text || "(no output)"}` }], details: undefined };
      }
      const snapshot = await operations.stop(id, "stopped by process tool");
      return { content: [{ type: "text", text: `Stopped background process. ${formatSnapshot(snapshot)}` }], details: undefined };
    },
  };
}
