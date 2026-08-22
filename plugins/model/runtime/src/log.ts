/**
 * Minimal structured logger shared by the model runtime and its consumers. The library
 * never writes files: entries go to an injectable sink (setLogSink). Without
 * a sink, warn/error fall back to console.error and debug/info are dropped.
 * Logging must never throw into the caller.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	ts: string;
	level: LogLevel;
	component: string;
	msg: string;
	[field: string]: unknown;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
	debug(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
}

let sink: LogSink | undefined;

/** Install the process-wide log sink. Pass undefined to restore the default. */
export function setLogSink(next: LogSink | undefined): void {
	sink = next;
}

function jsonReplacer(): (key: string, value: unknown) => unknown {
	const seen = new WeakSet<object>();
	return (_key, value) => {
		if (typeof value === "bigint") return value.toString();
		if (typeof value === "object" && value !== null) {
			if (seen.has(value)) return "[Circular]";
			seen.add(value);
		}
		return value;
	};
}

/** JSON.stringify that never throws: circular refs and BigInts degrade instead of dropping the entry. */
export function stringifyLogEntry(entry: LogEntry): string {
	try {
		return JSON.stringify(entry, jsonReplacer());
	} catch {
		return JSON.stringify({
			ts: entry.ts,
			level: entry.level,
			component: entry.component,
			msg: String(entry.msg),
			fieldsError: "unserializable fields dropped",
		});
	}
}

function emit(level: LogLevel, component: string, msg: string, fields?: Record<string, unknown>): void {
	try {
		// Reserved keys win over caller fields so entries can't be misclassified.
		const entry: LogEntry = { ...fields, ts: new Date().toISOString(), level, component, msg };
		try {
			if (sink) {
				sink(entry);
				return;
			}
		} catch (error) {
			process.stderr.write(`${JSON.stringify({
				type: "friday.model-log-sink-failure",
				at: new Date().toISOString(),
				component,
				level,
				errorName: error instanceof Error ? error.name : typeof error,
			})}\n`);
			// Broken sink: fall through to the console fallback.
		}
		if (level === "warn" || level === "error") {
			console.error(stringifyLogEntry(entry));
		}
	} catch (error) {
		// stderr is the non-recursive terminal sink for failures in logging itself.
		try {
			process.stderr.write(`${JSON.stringify({
				type: "friday.model-logger-failure",
				at: new Date().toISOString(),
				component,
				level,
				errorName: error instanceof Error ? error.name : typeof error,
			})}\n`);
		} catch {
			// No further sink exists if stderr itself fails.
		}
	}
}

export function getLogger(component: string): Logger {
	return {
		debug: (msg, fields) => emit("debug", component, msg, fields),
		info: (msg, fields) => emit("info", component, msg, fields),
		warn: (msg, fields) => emit("warn", component, msg, fields),
		error: (msg, fields) => emit("error", component, msg, fields),
	};
}
