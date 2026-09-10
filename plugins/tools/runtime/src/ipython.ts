import { type Static, Type } from "typebox";
import {
  executionAccess,
  type KernelHandle,
  type KernelExecuteResult,
  type KernelHostRequestHandler,
  type KernelLaunchRequest,
  type KernelLaunchSpec,
} from "./execution-access.js";
import { parseIpythonBashCell } from "./ipython-cell-code.js";
import type { ImageContent, Tool } from "./types.js";

const ipythonSchema = Type.Object({
  code: Type.String({
    description:
      "Python scratchpad code or `%%bash` shell cells to execute in the persistent agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
  }),
  fresh: Type.Optional(Type.Boolean({
    description:
      "Set true only when a clean Python process is useful. FRIDAY kills the current persistent kernel, starts a fresh one, then runs this code. Existing Python variables, imports, and helper functions are discarded.",
  })),
});

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type IpythonToolInput = Static<typeof ipythonSchema>;

export interface IpythonToolDetails {
  durationMs?: number;
  status?: "ok" | "error" | "aborted" | "starting";
  errorEname?: string;
  stdout?: string;
  stderr?: string;
  result?: string;
  displayData?: KernelExecuteResult["displayData"];
  error?: { ename: string; evalue: string; traceback: string[] };
}

export interface IpythonToolOptions {
  python?: string;
  env?: Record<string, string>;
  commandPrefix?: string;
  shellPath?: string;
  sessionId?: string;
  hostHandlers?: Record<string, KernelHostRequestHandler>;
  provisioner?: IpythonKernelProvisioner;
  onBusyKernel?: () => Promise<"wait" | "kill" | "cancel">;
  beforeExecute?: (code: string, signal?: AbortSignal) => Promise<void>;
  transport?: "tcp" | "ipc";
  launcher?: (request: KernelLaunchRequest) => KernelLaunchSpec;
}

function quoteScriptMagicArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function applyShellSettingsToBashMagicCell(
  code: string,
  options: Pick<IpythonToolOptions, "commandPrefix" | "shellPath"> | undefined,
): string {
  const commandPrefix = options?.commandPrefix;
  const shellPath = options?.shellPath?.trim();
  if (!commandPrefix && !shellPath) return code;

  const bashCell = parseIpythonBashCell(code);
  if (!bashCell) return code;

  const firstLine =
    shellPath && bashCell.magicArguments.trim().length === 0
      ? `${bashCell.indent}%%script ${quoteScriptMagicArgument(shellPath)}`
      : `${bashCell.indent}%%bash${bashCell.magicArguments}`;
  const nextBody = commandPrefix ? `${commandPrefix}${bashCell.body ? `\n${bashCell.body}` : ""}` : bashCell.body;
  return `${bashCell.leadingWhitespace}${firstLine}${bashCell.lineBreak || "\n"}${nextBody}`;
}

function isBusyKernelError(error: unknown): boolean {
  return error instanceof Error && error.name === "KernelBusyAfterInterruptError";
}

function imageBlocksFromDisplayData(displayData: KernelExecuteResult["displayData"]): ImageContent[] {
  if (!displayData) return [];
  const images: ImageContent[] = [];
  for (const display of displayData) {
    for (const mimeType of IMAGE_MIME_TYPES) {
      const data = display.data[mimeType];
      if (typeof data === "string") images.push({ type: "image", data, mimeType });
    }
  }
  return images;
}

export class IpythonKernelProvisioner {
  private manager?: KernelHandle;

  constructor(
    private readonly cwd: string,
    private readonly options?: Omit<IpythonToolOptions, "provisioner">,
  ) {}

  get hasRunningKernel(): boolean {
    return this.manager !== undefined;
  }

  ensure(): KernelHandle {
    this.manager ??= executionAccess().createKernel({
      python: this.options?.python,
      cwd: this.cwd,
      env: this.options?.env,
      sessionId: this.options?.sessionId,
      hostHandlers: this.options?.hostHandlers,
      transport: this.options?.transport,
      launcher: this.options?.launcher,
    });
    return this.manager;
  }

  async dispose(): Promise<void> {
    const manager = this.manager;
    this.manager = undefined;
    await manager?.dispose();
  }

  async restart(): Promise<void> {
    await this.manager?.restart();
  }

  async kill(): Promise<void> {
    const manager = this.manager;
    this.manager = undefined;
    await manager?.kill();
  }
}

async function executeWithBusyKernelChoice(
  provisioner: IpythonKernelProvisioner,
  code: string,
  signal: AbortSignal | undefined,
  onStream: (chunk: string, name: "stdout" | "stderr") => void,
  onBusyKernel: IpythonToolOptions["onBusyKernel"],
): Promise<{ result: KernelExecuteResult; kernelRestarted: boolean }> {
  let kernelRestarted = false;
  while (true) {
    const manager = provisioner.ensure();
    try {
      return {
        result: await manager.execute(code, { signal, onStream }),
        kernelRestarted,
      };
    } catch (error) {
      if (!isBusyKernelError(error) || signal?.aborted) throw error;
      const action = (await onBusyKernel?.()) ?? "cancel";
      if (action === "wait") continue;
      if (action === "kill") {
        await provisioner.kill();
        kernelRestarted = true;
        continue;
      }
      throw error;
    }
  }
}

export function createIpythonTool(
  cwd: string,
  options?: IpythonToolOptions,
): Tool<typeof ipythonSchema, IpythonToolDetails> {
  const provisioner = options?.provisioner ?? new IpythonKernelProvisioner(cwd, options);

  return {
    name: "ipython",
    label: "ipython",
    description:
      "Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
    parameters: ipythonSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      const code = applyShellSettingsToBashMagicCell(params.code, options);
      if (params.fresh === true) {
        // Authorize the requested execution before destroying useful notebook
        // state. A denied call must leave the current persistent kernel intact.
        await options?.beforeExecute?.(code, signal);
        await provisioner.restart();
      }
      if (!provisioner.hasRunningKernel) {
        onUpdate?.({
          content: [{ type: "text", text: params.fresh === true ? "starting fresh Python kernel" : "starting Python kernel" }],
          details: { status: "starting" },
        });
      }
      if (params.fresh !== true) await options?.beforeExecute?.(code, signal);
      const { result, kernelRestarted } = await executeWithBusyKernelChoice(
        provisioner,
        code,
        signal,
        (chunk) => {
          onUpdate?.({ content: [{ type: "text", text: chunk }], details: { status: "ok" } });
        },
        options?.onBusyKernel,
      );

      let text = result.stdout;
      if (result.stderr) text += (text ? "\n" : "") + result.stderr;
      if (result.result) text += (text ? "\n" : "") + result.result;
      if (result.status === "error" && result.error) {
        text += (text ? "\n" : "") + result.error.traceback.join("\n");
      }
      if (kernelRestarted) {
        const notice = "The Python kernel was restarted; recreate in-memory state from before the restart.";
        text = text ? `${notice}\n\n${text}` : notice;
      }

      if (result.status === "aborted") {
        throw new Error(text ? `${text}\n\nIPython execution aborted` : "IPython execution aborted");
      }
      if (result.status === "error") {
        throw new Error(text || result.error?.evalue || "IPython execution failed");
      }

      return {
        content: [{ type: "text", text: text || "" }, ...imageBlocksFromDisplayData(result.displayData)],
        details: {
          durationMs: result.durationMs,
          status: result.status,
          errorEname: result.error?.ename,
          stdout: result.stdout,
          stderr: result.stderr,
          result: result.result,
          displayData: result.displayData,
          error: result.error,
        },
      };
    },
  };
}
