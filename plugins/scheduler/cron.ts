import type { ScheduleSpec } from "./contract.js";

const MINUTE_MS = 60_000;
const MAX_CRON_SEARCH_MINUTES = 60 * 24 * 366 * 5;

const MONTH_NAMES = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
]);
const DAY_NAMES = new Map([
  ["sun", 0], ["mon", 1], ["tue", 2], ["wed", 3], ["thu", 4], ["fri", 5], ["sat", 6],
]);

interface CronField {
  values: ReadonlySet<number>;
  wildcard: boolean;
}

export interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function namedNumber(value: string, names: ReadonlyMap<string, number> | undefined): number | undefined {
  const named = names?.get(value.toLowerCase());
  if (named !== undefined) return named;
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function parseField(
  raw: string,
  minimum: number,
  maximum: number,
  label: string,
  names?: ReadonlyMap<string, number>,
  normalize?: (value: number) => number,
): CronField {
  const values = new Set<number>();
  const wildcard = raw === "*";
  for (const part of raw.split(",")) {
    if (!part) throw new Error(`cron ${label} contains an empty list item`);
    const [rangeRaw, stepRaw, extra] = part.split("/");
    if (extra !== undefined || rangeRaw === undefined) throw new Error(`invalid cron ${label}: ${raw}`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`cron ${label} step must be a positive integer`);

    let start: number;
    let end: number;
    if (rangeRaw === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeRaw.includes("-")) {
      const [startRaw, endRaw, tooMany] = rangeRaw.split("-");
      if (tooMany !== undefined || startRaw === undefined || endRaw === undefined) {
        throw new Error(`invalid cron ${label} range: ${rangeRaw}`);
      }
      const parsedStart = namedNumber(startRaw, names);
      const parsedEnd = namedNumber(endRaw, names);
      if (parsedStart === undefined || parsedEnd === undefined) throw new Error(`invalid cron ${label} range: ${rangeRaw}`);
      start = parsedStart;
      end = parsedEnd;
    } else {
      const parsed = namedNumber(rangeRaw, names);
      if (parsed === undefined) throw new Error(`invalid cron ${label} value: ${rangeRaw}`);
      start = parsed;
      end = stepRaw === undefined ? parsed : maximum;
    }

    if (start < minimum || start > maximum || end < minimum || end > maximum || start > end) {
      throw new Error(`cron ${label} values must be between ${minimum} and ${maximum}`);
    }
    for (let value = start; value <= end; value += step) values.add(normalize ? normalize(value) : value);
  }
  if (values.size === 0) throw new Error(`cron ${label} must select at least one value`);
  return { values, wildcard };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length !== 5) throw new Error("cron expression must contain exactly 5 fields: minute hour day month weekday");
  return {
    minute: parseField(fields[0]!, 0, 59, "minute"),
    hour: parseField(fields[1]!, 0, 23, "hour"),
    dayOfMonth: parseField(fields[2]!, 1, 31, "day-of-month"),
    month: parseField(fields[3]!, 1, 12, "month", MONTH_NAMES),
    dayOfWeek: parseField(fields[4]!, 0, 7, "day-of-week", DAY_NAMES, (value) => value === 7 ? 0 : value),
  };
}

export function normalizeTimeZone(timezone: string): string {
  const value = timezone.trim();
  if (!value) throw new Error("cron.timezone is required");
  try {
    // Validate through Intl, but preserve the exact valid identifier the user
    // configured. Some ICU builds canonicalize Asia/Kolkata to the historical
    // alias Asia/Calcutta, which is semantically equivalent but surprising in
    // persisted configuration and status output.
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    throw new Error(`Invalid IANA timezone: ${JSON.stringify(timezone)}`);
  }
}

function zonedParts(date: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = DAY_NAMES.get(value("weekday").toLowerCase());
  if (weekday === undefined) throw new Error(`Unable to resolve weekday in timezone ${timezone}`);
  return {
    minute: Number(value("minute")),
    hour: Number(value("hour")) % 24,
    day: Number(value("day")),
    month: Number(value("month")),
    weekday,
  };
}

function cronMatches(parsed: ParsedCronExpression, date: Date, timezone: string): boolean {
  const local = zonedParts(date, timezone);
  if (!parsed.minute.values.has(local.minute) || !parsed.hour.values.has(local.hour) || !parsed.month.values.has(local.month)) {
    return false;
  }
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(local.day);
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(local.weekday);
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return dayOfWeekMatch;
  if (parsed.dayOfWeek.wildcard) return dayOfMonthMatch;
  return dayOfMonthMatch || dayOfWeekMatch;
}

export function nextCronOccurrence(expression: string, timezone: string, after: Date): string {
  const parsed = parseCronExpression(expression);
  const normalizedTimezone = normalizeTimeZone(timezone);
  const afterMs = after.getTime();
  let candidateMs = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let index = 0; index < MAX_CRON_SEARCH_MINUTES; index += 1, candidateMs += MINUTE_MS) {
    const candidate = new Date(candidateMs);
    if (cronMatches(parsed, candidate, normalizedTimezone)) return candidate.toISOString();
  }
  throw new Error("cron expression produced no occurrence within the 5-year search horizon");
}

export function normalizeTimestamp(value: string, label: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be an ISO-compatible timestamp`);
  return new Date(millis).toISOString();
}

export function normalizeSchedule(schedule: ScheduleSpec, now: Date): { schedule: ScheduleSpec; nextRunAt: string } {
  if (schedule.kind === "once") {
    const at = normalizeTimestamp(schedule.at, "once.at");
    return { schedule: { kind: "once", at }, nextRunAt: at };
  }
  if (schedule.kind === "interval") {
    if (!Number.isInteger(schedule.everyMs) || schedule.everyMs <= 0) {
      throw new Error("interval.everyMs must be a positive integer");
    }
    const startAt = schedule.startAt ? normalizeTimestamp(schedule.startAt, "interval.startAt") : now.toISOString();
    return {
      schedule: { kind: "interval", everyMs: schedule.everyMs, startAt },
      nextRunAt: startAt,
    };
  }
  const expression = schedule.expression.trim().replace(/\s+/g, " ");
  parseCronExpression(expression);
  const timezone = normalizeTimeZone(schedule.timezone);
  return {
    schedule: { kind: "cron", expression, timezone },
    nextRunAt: nextCronOccurrence(expression, timezone, now),
  };
}

export function nextScheduleOccurrence(schedule: ScheduleSpec, after: Date): string | undefined {
  if (schedule.kind === "once") return undefined;
  if (schedule.kind === "interval") return new Date(after.getTime() + schedule.everyMs).toISOString();
  return nextCronOccurrence(schedule.expression, schedule.timezone, after);
}

export function nextFutureOccurrence(schedule: ScheduleSpec, currentOccurrence: string, after: Date): string | undefined {
  if (schedule.kind === "once") return undefined;
  if (schedule.kind === "cron") return nextCronOccurrence(schedule.expression, schedule.timezone, after);
  let nextMs = Date.parse(currentOccurrence) + schedule.everyMs;
  const afterMs = after.getTime();
  if (nextMs <= afterMs) {
    const missed = Math.floor((afterMs - nextMs) / schedule.everyMs) + 1;
    nextMs += missed * schedule.everyMs;
  }
  return new Date(nextMs).toISOString();
}
