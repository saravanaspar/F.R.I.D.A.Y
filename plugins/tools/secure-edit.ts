import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EditOperations } from "@friday/tools";
import type { ExecutionService } from "../execution/contract.js";
import type { SandboxService } from "../sandbox/contract.js";

const MAX_EDIT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EDIT_COMMAND_OUTPUT_BYTES = 12 * 1024 * 1024;
const EDIT_COMMAND_TIMEOUT_MS = 30_000;

const SECURE_EDIT_HELPER = String.raw`
import base64, hashlib, os, stat, sys

root, rel, operation, max_bytes_text = sys.argv[1:5]
max_bytes = int(max_bytes_text)
parts = rel.split('/')
if not parts or any(part in ('', '.', '..') for part in parts):
    raise RuntimeError('invalid workspace-relative path')

NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
DIRECTORY = getattr(os, 'O_DIRECTORY', 0)
root_fd = os.open(root, os.O_RDONLY | DIRECTORY | NOFOLLOW)
opened = [root_fd]
try:
    parent_fd = root_fd
    for part in parts[:-1]:
        next_fd = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
        opened.append(next_fd)
        parent_fd = next_fd
    name = parts[-1]
    file_fd = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=parent_fd)
    try:
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('edit target is not a regular file')
        if info.st_size > max_bytes:
            raise RuntimeError('edit target exceeds the maximum editable file size')
        chunks = []
        size = 0
        while True:
            chunk = os.read(file_fd, min(1024 * 1024, max_bytes + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > max_bytes:
                raise RuntimeError('edit target exceeds the maximum editable file size')
        current = b''.join(chunks)
        current_mode = info.st_mode & 0o777
    finally:
        os.close(file_fd)

    if operation == 'read':
        sys.stdout.write(base64.b64encode(current).decode('ascii'))
    elif operation == 'write':
        expected_hash = sys.argv[5]
        if hashlib.sha256(current).hexdigest() != expected_hash:
            raise RuntimeError('edit target changed after it was read; retry the edit')
        replacement = sys.stdin.buffer.read(max_bytes + 1)
        if len(replacement) > max_bytes:
            raise RuntimeError('edited content exceeds the maximum editable file size')
        temp_name = f'.friday-edit-{os.getpid()}-{os.urandom(8).hex()}.tmp'
        temp_fd = None
        try:
            temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=parent_fd)
            offset = 0
            while offset < len(replacement):
                offset += os.write(temp_fd, replacement[offset:])
            os.fsync(temp_fd)
            os.fchmod(temp_fd, current_mode)
            os.close(temp_fd)
            temp_fd = None
            os.replace(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            if temp_fd is not None:
                os.close(temp_fd)
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
    else:
        raise RuntimeError('unknown secure edit operation')
finally:
    for descriptor in reversed(opened):
        try:
            os.close(descriptor)
        except OSError:
            pass
`;

function workspaceRelative(workspace: string, absolutePath: string): string {
  const root = resolve(workspace);
  const target = resolve(absolutePath);
  const rel = relative(root, target);
  if (!rel || rel === ".") throw new Error("Edit target must be a file inside the workspace");
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Edit target is outside the workspace");
  }
  return rel.split(sep).join("/");
}

async function runHelper(
  cwd: string,
  relativePath: string,
  operation: "read" | "write",
  execution: ExecutionService,
  sandbox: SandboxService,
  input?: Buffer,
  expectedHash?: string,
): Promise<string> {
  const args = ["-c", SECURE_EDIT_HELPER, cwd, relativePath, operation, String(MAX_EDIT_FILE_BYTES)];
  if (expectedHash !== undefined) args.push(expectedHash);
  const context = sandbox.sandboxProcess({
    command: "python3",
    args,
    cwd,
    workspace: cwd,
    access: "write",
    network: false,
    env: { ...process.env },
    interactive: input !== undefined,
  });
  const result = await execution.api.execCommand(context.command, context.args, context.cwd, {
    env: context.env,
    timeout: EDIT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_EDIT_COMMAND_OUTPUT_BYTES,
    ...(input === undefined ? {} : { stdin: input }),
  });
  if (result.outputLimitExceeded) throw new Error("Secure edit helper exceeded its output limit");
  if (result.code !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 400) || `exit code ${result.code}`;
    throw new Error(`Secure edit failed: ${detail}`);
  }
  return result.stdout;
}

export function createSecureEditOperations(
  cwd: string,
  execution: ExecutionService,
  sandbox: SandboxService,
): EditOperations {
  return Object.freeze({
    async readFile(absolutePath: string): Promise<Buffer> {
      const rel = workspaceRelative(cwd, absolutePath);
      const encoded = await runHelper(cwd, rel, "read", execution, sandbox);
      const buffer = Buffer.from(encoded.trim(), "base64");
      if (buffer.length > MAX_EDIT_FILE_BYTES) throw new Error("Edit target exceeds the maximum editable file size");
      return buffer;
    },
    async writeFile(absolutePath: string, content: string, expectedOriginal?: Buffer): Promise<void> {
      if (expectedOriginal === undefined) throw new Error("Secure edit requires the original file content");
      const rel = workspaceRelative(cwd, absolutePath);
      const expectedHash = createHash("sha256").update(expectedOriginal).digest("hex");
      const replacement = Buffer.from(content, "utf8");
      if (replacement.length > MAX_EDIT_FILE_BYTES) throw new Error("Edited content exceeds the maximum editable file size");
      await runHelper(cwd, rel, "write", execution, sandbox, replacement, expectedHash);
    },
  });
}
