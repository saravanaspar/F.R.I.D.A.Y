import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import type { Tool } from "./types.js";

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    }),
  },
  { additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };

export interface EditToolDetails {
  diff: string;
  firstChangedLine?: number;
}

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string, expectedOriginal?: Buffer) => Promise<void>;
  access?: ((absolutePath: string) => Promise<void>) | undefined;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: async (path, content, expectedOriginal) => {
    if (expectedOriginal !== undefined) {
      const current = await fsReadFile(path);
      if (!current.equals(expectedOriginal)) throw new Error("File changed while the edit was being prepared; retry the edit");
    }
    await fsWriteFile(path, content, "utf-8");
  },
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
  operations?: EditOperations;
  pathGuard?: (absolutePath: string) => void | Promise<void>;
}

export function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") return input as EditToolInput;

  const args = input as Record<string, unknown>;
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      // friday-expected-control-flow: schema validation below owns the user-facing rejection.
    }
  }

  const legacy = args as LegacyEditToolInput;
  if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
    return args as EditToolInput;
  }

  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = legacy;
  return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

export function createEditTool(cwd: string, options?: EditToolOptions): Tool<typeof editSchema, EditToolDetails | undefined> {
  const operations = options?.operations ?? defaultEditOperations;
  const pathGuard = options?.pathGuard;

  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editSchema,
    prepareArguments: prepareEditArguments,
    async execute(_toolCallId, input, signal) {
      const { path, edits } = validateEditInput(input);
      const absolutePath = resolveToCwd(path, cwd);

      return withFileMutationQueue(
        absolutePath,
        () =>
          new Promise((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("Operation aborted"));
              return;
            }

            let aborted = false;
            const onAbort = () => {
              aborted = true;
              reject(new Error("Operation aborted"));
            };
            signal?.addEventListener("abort", onAbort, { once: true });

            void (async () => {
              try {
                if (pathGuard) await pathGuard(absolutePath);
                try {
                  await operations.access?.(absolutePath);
                } catch (error: unknown) {
                  const errorMessage =
                    error instanceof Error && "code" in error ? `Error code: ${(error as Error & { code?: string }).code}` : String(error);
                  signal?.removeEventListener("abort", onAbort);
                  reject(new Error(`Could not edit file: ${path}. ${errorMessage}.`));
                  return;
                }

                if (aborted) return;
                const buffer = await operations.readFile(absolutePath);
                const rawContent = buffer.toString("utf-8");
                if (aborted) return;

                const { bom, text: content } = stripBom(rawContent);
                const originalEnding = detectLineEnding(content);
                const normalizedContent = normalizeToLF(content);
                const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
                if (aborted) return;

                const finalContent = bom + restoreLineEndings(newContent, originalEnding);
                await operations.writeFile(absolutePath, finalContent, buffer);
                if (aborted) return;

                signal?.removeEventListener("abort", onAbort);
                const diffResult = generateDiffString(baseContent, newContent);
                resolve({
                  content: [{ type: "text" as const, text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
                  details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
                });
              } catch (error: unknown) {
                signal?.removeEventListener("abort", onAbort);
                if (!aborted) reject(error instanceof Error ? error : new Error(String(error)));
              }
            })();
          }),
      );
    },
  };
}
