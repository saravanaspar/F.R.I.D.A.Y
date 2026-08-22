import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.js";

export const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const DEFAULT_OUTPUT_FILE_MAX_AGE_MS = 24 * 60 * 60_000;

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	maxTotalBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly maxTotalBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private totalLines = 1;
	private currentLineBytes = 0;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
		if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < this.maxBytes) {
			throw new Error("maxTotalBytes must be an integer at least as large as maxBytes");
		}
		this.tempFilePrefix = options.tempFilePrefix ?? "friday-output";
	}

	append(data: Buffer): boolean {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		const remaining = Math.max(0, this.maxTotalBytes - this.totalRawBytes);
		const accepted = data.length <= remaining ? data : data.subarray(0, remaining);
		this.totalRawBytes += data.length;
		if (accepted.length > 0) {
			this.appendDecodedText(this.decoder.decode(accepted, { stream: true }));
			if (this.tempFileStream || this.shouldUseTempFile()) {
				this.ensureTempFile();
				this.tempFileStream?.write(accepted);
			} else {
				this.rawChunks.push(Buffer.from(accepted));
			}
		}
		return data.length <= remaining;
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
		} else {
			this.totalLines += newlines;
			this.currentLineBytes = byteLength(text.slice(lastNewline + 1));
		}
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		this.tempFileStream = createWriteStream(this.tempFilePath, { flags: "wx", mode: 0o600 });
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		this.rawChunks = [];
	}
}

export async function cleanupStaleOutputFiles(options: { prefix?: string; maxAgeMs?: number; now?: number } = {}): Promise<number> {
	const prefix = `${options.prefix ?? "friday-bash"}-`;
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_OUTPUT_FILE_MAX_AGE_MS;
	const now = options.now ?? Date.now();
	let removed = 0;
	for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".log")) continue;
		const path = join(tmpdir(), entry.name);
		try {
			const info = await stat(path);
			if (now - info.mtimeMs < maxAgeMs) continue;
			await unlink(path);
			removed += 1;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return removed;
}
