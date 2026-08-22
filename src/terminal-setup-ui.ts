import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { OnboardingIO, OnboardingSelectInput } from "./onboarding.js";

const ESC = "\u001b[";
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const useColor = interactive && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function paint(code: number, text: string): string {
  return useColor ? `${ESC}${code}m${text}${ESC}0m` : text;
}

const color = Object.freeze({
  dim: (text: string) => paint(2, text),
  bold: (text: string) => paint(1, text),
  cyan: (text: string) => paint(36, text),
  green: (text: string) => paint(32, text),
  yellow: (text: string) => paint(33, text),
  red: (text: string) => paint(31, text),
  magenta: (text: string) => paint(35, text),
});

function terminalWidth(): number {
  return Math.max(48, Math.min(100, process.stdout.columns || 80));
}

function clip(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  if (maximum <= 1) return "…";
  return `${text.slice(0, maximum - 1)}…`;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function wrap(text: string, width: number): readonly string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return Object.freeze([""]);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return Object.freeze(lines);
}

class PromptCancelledError extends Error {
  constructor() {
    super("setup cancelled");
    this.name = "PromptCancelledError";
  }
}

let keypressInitialized = false;

interface RawPromptSession {
  readonly wasRaw: boolean;
  close(): void;
}

function beginRawPrompt(): RawPromptSession {
  if (!interactive || !process.stdin.setRawMode) throw new Error("interactive terminal input is unavailable");
  if (!keypressInitialized) {
    emitKeypressEvents(process.stdin);
    keypressInitialized = true;
  }
  const wasRaw = process.stdin.isRaw === true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return {
    wasRaw,
    close() {
      process.stdin.setRawMode(wasRaw);
      process.stdout.write(`${ESC}?25h`);
    },
  };
}

function clearRendered(lines: number): void {
  if (lines <= 0) return;
  process.stdout.write(`${ESC}${lines}A`);
  for (let index = 0; index < lines; index += 1) {
    process.stdout.write(`${ESC}2K\r`);
    if (index < lines - 1) process.stdout.write(`${ESC}1B`);
  }
  if (lines > 1) process.stdout.write(`${ESC}${lines - 1}A`);
}

function renderBlock(previousLines: number, lines: readonly string[]): number {
  clearRendered(previousLines);
  process.stdout.write(`${lines.join("\n")}\n`);
  return lines.length;
}

async function linePrompt(prompt: string, options: { readonly secret?: boolean; readonly defaultValue?: string } = {}): Promise<string> {
  if (!interactive) {
    const { createInterface } = await import("node:readline/promises");
    const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    try {
      const answer = await readline.question(prompt);
      return answer.trim() ? answer : (options.defaultValue ?? answer);
    } finally {
      readline.close();
    }
  }

  const session = beginRawPrompt();
  process.stdout.write(`${ESC}?25h`);
  let value = "";
  let cursor = 0;

  const draw = (): void => {
    const visible = options.secret ? "•".repeat([...value].length) : value;
    const prefix = `${color.cyan("◆")} ${prompt}`;
    const fallback = !visible && options.defaultValue ? color.dim(options.defaultValue) : "";
    process.stdout.write(`\r${ESC}2K${prefix}${visible || fallback}`);
    if (visible && cursor < value.length) {
      process.stdout.write(`${ESC}${value.length - cursor}D`);
    }
  };
  draw();

  try {
    return await new Promise<string>((resolve, reject) => {
      const onKeypress = (character: string | undefined, key: Key): void => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(new PromptCancelledError());
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          const answer = value || options.defaultValue || "";
          cleanup();
          process.stdout.write("\n");
          resolve(answer);
          return;
        }
        if (key.name === "left") cursor = Math.max(0, cursor - 1);
        else if (key.name === "right") cursor = Math.min(value.length, cursor + 1);
        else if (key.name === "home") cursor = 0;
        else if (key.name === "end") cursor = value.length;
        else if (key.name === "backspace" && cursor > 0) {
          value = `${value.slice(0, cursor - 1)}${value.slice(cursor)}`;
          cursor -= 1;
        } else if (key.name === "delete" && cursor < value.length) {
          value = `${value.slice(0, cursor)}${value.slice(cursor + 1)}`;
        } else if (key.ctrl && key.name === "u") {
          value = "";
          cursor = 0;
        } else if (!key.ctrl && !key.meta && character && character >= " ") {
          value = `${value.slice(0, cursor)}${character}${value.slice(cursor)}`;
          cursor += character.length;
        }
        draw();
      };
      const cleanup = (): void => {
        process.stdin.off("keypress", onKeypress);
      };
      process.stdin.on("keypress", onKeypress);
    });
  } finally {
    session.close();
  }
}

function scoreOption(option: OnboardingSelectInput["choices"][number], query: string): number {
  if (!query) return 1;
  const needle = query.toLowerCase();
  const label = option.label.toLowerCase();
  const value = option.value.toLowerCase();
  const keywords = (option.keywords ?? []).join(" ").toLowerCase();
  if (value === needle || label === needle) return 100;
  if (value.startsWith(needle) || label.startsWith(needle)) return 50;
  if (value.includes(needle) || label.includes(needle)) return 20;
  if (keywords.includes(needle)) return 10;
  const tokens = needle.split(/\s+/).filter(Boolean);
  return tokens.every((token) => `${label} ${value} ${keywords}`.includes(token)) ? 5 : 0;
}

async function selectPrompt(input: OnboardingSelectInput): Promise<string> {
  const choices = [...input.choices];
  if (choices.length === 0) throw new Error(`${input.message} has no choices`);
  if (!interactive) return input.initialValue ?? choices[0]!.value;

  const session = beginRawPrompt();
  process.stdout.write(`${ESC}?25l`);
  let query = "";
  let selectedValue = input.initialValue ?? choices[0]!.value;
  let rendered = 0;
  const maxItems = Math.max(5, Math.min(input.maxItems ?? 8, 12));

  const filtered = (): typeof choices => choices
    .map((choice, index) => ({ choice, index, score: scoreOption(choice, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.choice);

  const draw = (): void => {
    const matches = filtered();
    if (!matches.some((choice) => choice.value === selectedValue)) selectedValue = matches[0]?.value ?? "";
    let selected = Math.max(0, matches.findIndex((choice) => choice.value === selectedValue));
    if (selected < 0) selected = 0;
    const start = Math.max(0, Math.min(selected - Math.floor(maxItems / 2), Math.max(0, matches.length - maxItems)));
    const visible = matches.slice(start, start + maxItems);
    const width = terminalWidth();
    const lines: string[] = [
      `${color.cyan("◆")} ${color.bold(input.message)}`,
    ];
    if (input.searchable !== false) {
      lines.push(`${color.dim("│")} ${color.dim("Search")} ${query ? color.cyan(query) : color.dim("type to filter…")}`);
    }
    lines.push(color.dim("│"));
    if (visible.length === 0) {
      lines.push(`${color.dim("│")}  ${color.yellow("No matches")} ${color.dim("— keep typing or Backspace")}`);
    } else {
      for (const choice of visible) {
        const active = choice.value === selectedValue;
        const marker = active ? color.cyan("❯") : " ";
        const label = active ? color.cyan(choice.label) : choice.label;
        const hintBudget = Math.max(0, width - stripAnsi(label).length - 10);
        const hint = choice.hint && hintBudget > 8 ? ` ${color.dim(clip(choice.hint, hintBudget))}` : "";
        lines.push(`${color.dim("│")} ${marker} ${label}${hint}`);
      }
      if (matches.length > visible.length) {
        lines.push(`${color.dim("│")}   ${color.dim(`${start + 1}–${start + visible.length} of ${matches.length}`)}`);
      }
    }
    lines.push(`${color.dim("└")} ${color.dim(input.searchable === false ? "↑↓ move · Enter select · Ctrl+C cancel" : "type search · ↑↓ move · Enter select · Ctrl+C cancel")}`);
    rendered = renderBlock(rendered, lines);
  };
  draw();

  try {
    return await new Promise<string>((resolve, reject) => {
      const onKeypress = (character: string | undefined, key: Key): void => {
        const matches = filtered();
        const currentIndex = Math.max(0, matches.findIndex((choice) => choice.value === selectedValue));
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(new PromptCancelledError());
          return;
        }
        if ((key.name === "return" || key.name === "enter") && selectedValue) {
          cleanup();
          clearRendered(rendered);
          const selected = choices.find((choice) => choice.value === selectedValue)!;
          process.stdout.write(`${color.green("◇")} ${input.message}\n${color.dim("│")} ${color.green(selected.label)}\n`);
          resolve(selectedValue);
          return;
        }
        if (key.name === "up" && matches.length) {
          selectedValue = matches[(currentIndex - 1 + matches.length) % matches.length]!.value;
        } else if (key.name === "down" && matches.length) {
          selectedValue = matches[(currentIndex + 1) % matches.length]!.value;
        } else if (key.name === "pageup" && matches.length) {
          selectedValue = matches[Math.max(0, currentIndex - maxItems)]!.value;
        } else if (key.name === "pagedown" && matches.length) {
          selectedValue = matches[Math.min(matches.length - 1, currentIndex + maxItems)]!.value;
        } else if (input.searchable !== false && key.name === "backspace") {
          query = query.slice(0, -1);
        } else if (input.searchable !== false && key.ctrl && key.name === "u") {
          query = "";
        } else if (input.searchable !== false && !key.ctrl && !key.meta && character && character >= " ") {
          query += character;
        }
        draw();
      };
      const cleanup = (): void => {
        process.stdin.off("keypress", onKeypress);
      };
      process.stdin.on("keypress", onKeypress);
    });
  } finally {
    session.close();
  }
}

async function confirmPrompt(message: string, initialValue = false): Promise<boolean> {
  const value = await selectPrompt({
    message,
    searchable: false,
    initialValue: initialValue ? "yes" : "no",
    maxItems: 2,
    choices: [
      { value: "yes", label: "Yes", hint: initialValue ? "recommended" : undefined },
      { value: "no", label: "No", hint: !initialValue ? "recommended" : undefined },
    ],
  });
  return value === "yes";
}

async function runTask<T>(message: string, task: () => Promise<T>): Promise<T> {
  if (!interactive) return task();
  const frames = ["◒", "◐", "◓", "◑"];
  let frame = 0;
  process.stdout.write(`${color.cyan(frames[0]!)} ${message}`);
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    process.stdout.write(`\r${ESC}2K${color.cyan(frames[frame]!)} ${message}`);
  }, 90);
  timer.unref();
  try {
    const result = await task();
    clearInterval(timer);
    process.stdout.write(`\r${ESC}2K${color.green("◇")} ${message} ${color.green("done")}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stdout.write(`\r${ESC}2K${color.red("◇")} ${message} ${color.red("failed")}\n`);
    throw error;
  }
}

function intro(title: string, subtitle?: string): void {
  const width = Math.min(68, terminalWidth() - 2);
  process.stdout.write("\n");
  process.stdout.write(`${color.magenta("◆")} ${color.bold(title)}\n`);
  if (subtitle) {
    for (const line of wrap(subtitle, width - 4)) process.stdout.write(`${color.dim("│")} ${color.dim(line)}\n`);
  }
  process.stdout.write(`${color.dim("│")}\n`);
}

function outro(title: string, details?: readonly string[]): void {
  process.stdout.write(`${color.green("◇")} ${color.bold(title)}\n`);
  for (const detail of details ?? []) process.stdout.write(`${color.dim("│")} ${detail}\n`);
  process.stdout.write(`${color.dim("└")} ${color.dim("You can rerun `friday setup` any time.")}\n\n`);
}

function info(message: string): void {
  process.stdout.write(`${color.dim("│")} ${message.trimEnd()}\n`);
}

function success(message: string): void {
  process.stdout.write(`${color.green("◇")} ${message.trimEnd()}\n`);
}

function warning(message: string): void {
  process.stdout.write(`${color.yellow("▲")} ${message.trimEnd()}\n`);
}

export function createTerminalOnboardingIO(): OnboardingIO {
  return {
    isInteractive: interactive,
    question: (prompt) => linePrompt(prompt),
    text: (prompt, initialValue) => linePrompt(`${prompt}: `, { ...(initialValue === undefined ? {} : { defaultValue: initialValue }) }),
    secretQuestion: (prompt) => linePrompt(prompt, { secret: true }),
    write: (text) => process.stdout.write(text),
    select: selectPrompt,
    confirm: confirmPrompt,
    runTask,
    intro,
    outro,
    info,
    success,
    warning,
    close: () => undefined,
  };
}
