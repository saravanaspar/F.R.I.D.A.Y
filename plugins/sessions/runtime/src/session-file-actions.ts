import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

/**
 * Permanently remove a session's artifact directory, which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 */
async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
	if (!sessionId) return;
	const artifactDir = join(dirname(dirname(sessionPath)), "session-artifacts", sessionId);
	await rm(artifactDir, { recursive: true, force: true });
}

/** Remove the session `.jsonl` using the filesystem API. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	if (!existsSync(sessionPath)) {
		return { ok: true, method: "unlink" };
	}
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also permanently removes the session's artifact directory, but only
 * once the session file itself is gone — otherwise a failed delete would orphan a
 * session whose kernel snapshot has already been destroyed.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		options.afterFileRemoved?.();
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}
