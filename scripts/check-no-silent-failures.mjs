#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensions = new Set([".ts", ".js", ".mjs", ".cjs", ".py"]);
const ignoredDirectories = new Set([".git", ".venv", "node_modules", "dist", "build", "coverage", "test", "tests", "__pycache__"]);
const failures = [];

function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child);
    else if (entry.isFile() && extensions.has(extname(entry.name)) && !entry.name.endsWith(".test.ts")) inspect(child);
  }
}

function add(path, line, reason) {
  failures.push(`${relative(root, path)}:${line}: ${reason}`);
}

function indentation(line) {
  let width = 0;
  while (width < line.length) {
    const code = line.charCodeAt(width);
    if (code !== 32 && code !== 9) break;
    width += 1;
  }
  return width;
}

function isPythonExceptHeader(trimmed) {
  return trimmed === "except:" || (trimmed.startsWith("except ") && trimmed.endsWith(":"));
}

function inspectPython(path, source) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!isPythonExceptHeader(trimmed)) continue;
    const parentIndent = indentation(line);
    let sawPass = false;
    let sawOther = false;
    for (let next = index + 1; next < lines.length; next += 1) {
      const child = lines[next] ?? "";
      const childTrimmed = child.trim();
      if (!childTrimmed || childTrimmed.startsWith("#")) continue;
      if (indentation(child) <= parentIndent) break;
      if (childTrimmed === "pass" && !sawPass) sawPass = true;
      else sawOther = true;
    }
    if (sawPass && !sawOther) add(path, index + 1, "empty Python exception handler");
  }
}

function isWhitespace(code) {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

function isIdentifierStart(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95;
}

function isIdentifierPart(code) {
  return isIdentifierStart(code) || isDigit(code);
}

function skipQuoted(source, start, quoteCode) {
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    index += 1;
    if (code === quoteCode) break;
  }
  return index;
}

function skipTemplate(source, start) {
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    index += 1;
    if (code === 96) break;
  }
  return index;
}

const regexPrefixTokens = new Set([
  "(", "[", "{", ",", ";", ":", "?", "=", "==", "===", "!=", "!==", "=>",
  "+", "-", "*", "/", "%", "**", "&", "|", "^", "!", "~", "&&", "||", "??",
  "<", ">", "<=", ">=", "<<", ">>", ">>>", "+=", "-=", "*=", "/=", "%=", "**=",
  "&=", "|=", "^=", "&&=", "||=", "??=", "return", "throw", "case", "delete", "void",
  "typeof", "new", "in", "of", "instanceof", "yield", "await", "else", "do",
]);

function canStartRegex(previous) {
  return previous === undefined || regexPrefixTokens.has(previous.value);
}

function skipRegex(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    if (code === 91) {
      inClass = true;
      index += 1;
      continue;
    }
    if (code === 93 && inClass) {
      inClass = false;
      index += 1;
      continue;
    }
    index += 1;
    if (code === 47 && !inClass) break;
    if (code === 10 || code === 13) break;
  }
  while (index < source.length && isIdentifierPart(source.charCodeAt(index))) index += 1;
  return index;
}

function punctuatorLength(source, index) {
  const three = source.slice(index, index + 3);
  if (["===", "!==", ">>>", "**=", "&&=", "||=", "??=", "<<=", ">>=", "..."].includes(three)) return 3;
  const two = source.slice(index, index + 2);
  if (["=>", "?.", "==", "!=", "<=", ">=", "++", "--", "&&", "||", "??", "**", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="].includes(two)) return 2;
  return 1;
}

function tokenizeJavaScript(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (isWhitespace(code)) {
      index += 1;
      continue;
    }

    if (code === 47 && source.charCodeAt(index + 1) === 47) {
      index += 2;
      while (index < source.length && source.charCodeAt(index) !== 10) index += 1;
      continue;
    }
    if (code === 47 && source.charCodeAt(index + 1) === 42) {
      index += 2;
      while (index < source.length) {
        if (source.charCodeAt(index) === 42 && source.charCodeAt(index + 1) === 47) {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (code === 34 || code === 39) {
      const end = skipQuoted(source, index, code);
      tokens.push({ value: "<string>", start: index, end });
      index = end;
      continue;
    }
    if (code === 96) {
      const end = skipTemplate(source, index);
      tokens.push({ value: "<template>", start: index, end });
      index = end;
      continue;
    }

    if (isIdentifierStart(code)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source.charCodeAt(index))) index += 1;
      tokens.push({ value: source.slice(start, index), start, end: index });
      continue;
    }

    if (isDigit(code)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source.charCodeAt(index))) index += 1;
      tokens.push({ value: source.slice(start, index), start, end: index });
      continue;
    }

    const previous = tokens.at(-1);
    if (code === 47 && canStartRegex(previous)) {
      const end = skipRegex(source, index);
      tokens.push({ value: "<regex>", start: index, end });
      index = end;
      continue;
    }

    const length = punctuatorLength(source, index);
    tokens.push({ value: source.slice(index, index + length), start: index, end: index + length });
    index += length;
  }
  return tokens;
}

function matchingToken(tokens, openIndex, openValue, closeValue) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === openValue) depth += 1;
    else if (value === closeValue) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

function allowedEmptyCatch(path, body) {
  if (path.endsWith("packages/operational-errors/src/index.ts") && body.includes("terminal failure sink")) return true;
  return body.includes("friday-expected-control-flow") || body.includes("No further sink exists");
}

function inspectCatchClause(path, source, tokens, index, starts) {
  const previous = tokens[index - 1]?.value;
  if (previous === "." || previous === "?.") return;

  let blockIndex = index + 1;
  if (tokens[blockIndex]?.value === "(") {
    const closeParen = matchingToken(tokens, blockIndex, "(", ")");
    if (closeParen < 0) return;
    blockIndex = closeParen + 1;
  }
  if (tokens[blockIndex]?.value !== "{") return;

  const closeBrace = matchingToken(tokens, blockIndex, "{", "}");
  if (closeBrace < 0 || closeBrace !== blockIndex + 1) return;
  const body = source.slice(tokens[blockIndex].end, tokens[closeBrace].start);
  if (allowedEmptyCatch(path, body)) return;
  add(path, lineAt(starts, tokens[index].start), "empty catch block");
}

function noOpArrowBody(source, tokens, bodyIndex) {
  const body = tokens[bodyIndex];
  if (!body) return false;
  if (body.value === "{") {
    const closeBrace = matchingToken(tokens, bodyIndex, "{", "}");
    if (closeBrace < 0 || closeBrace !== bodyIndex + 1) return false;
    return source.slice(body.end, tokens[closeBrace].start).trim().length === 0;
  }
  if (body.value === "undefined") return true;
  return body.value === "void" && tokens[bodyIndex + 1]?.value === "0";
}

function inspectPromiseCatch(path, source, tokens, index, starts) {
  const previous = tokens[index - 1]?.value;
  if (previous !== "." && previous !== "?.") return;
  if (tokens[index + 1]?.value !== "(") return;

  let cursor = index + 2;
  if (tokens[cursor]?.value === "async") cursor += 1;

  if (tokens[cursor]?.value === "(") {
    const closeParams = matchingToken(tokens, cursor, "(", ")");
    if (closeParams < 0) return;
    cursor = closeParams + 1;
  } else if (tokens[cursor] && isIdentifierStart(source.charCodeAt(tokens[cursor].start))) {
    cursor += 1;
  } else {
    return;
  }

  if (tokens[cursor]?.value !== "=>") return;
  const bodyIndex = cursor + 1;
  if (!noOpArrowBody(source, tokens, bodyIndex)) return;
  add(path, lineAt(starts, tokens[index].start), "promise rejection is discarded");
}

function inspectJavaScript(path, source) {
  const tokens = tokenizeJavaScript(source);
  const starts = lineStarts(source);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "catch") continue;
    inspectCatchClause(path, source, tokens, index, starts);
    inspectPromiseCatch(path, source, tokens, index, starts);
  }
}

function inspect(path) {
  const source = readFileSync(path, "utf8");
  if (path.endsWith(".py")) inspectPython(path, source);
  else inspectJavaScript(path, source);
}

for (const directory of ["src", "plugins", "packages", "scripts"]) visit(join(root, directory));
if (failures.length > 0) {
  process.stderr.write(`Silent-failure check found ${failures.length} violation(s):\n${failures.map((value) => `  ${value}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Silent-failure check passed.\n");
}
