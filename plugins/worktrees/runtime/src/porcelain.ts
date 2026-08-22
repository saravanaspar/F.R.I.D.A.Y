import type { ListedWorktree } from "./types.js";

function finish(current: Partial<ListedWorktree> | undefined): ListedWorktree | undefined {
  if (!current?.directory) return undefined;
  return {
    directory: current.directory,
    detached: current.detached ?? false,
    bare: current.bare ?? false,
    prunable: current.prunable ?? false,
    ...(current.head ? { head: current.head } : {}),
    ...(current.branch ? { branch: current.branch } : {}),
  };
}

export function parseWorktreePorcelain(text: string): ListedWorktree[] {
  const result: ListedWorktree[] = [];
  let current: Partial<ListedWorktree> | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      const entry = finish(current);
      if (entry) result.push(entry);
      current = undefined;
      continue;
    }

    if (line.startsWith("worktree ")) {
      const entry = finish(current);
      if (entry) result.push(entry);
      current = {
        directory: line.slice("worktree ".length),
        detached: false,
        bare: false,
        prunable: false,
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
    else if (line.startsWith("prunable")) current.prunable = true;
  }

  const entry = finish(current);
  if (entry) result.push(entry);
  return result;
}
