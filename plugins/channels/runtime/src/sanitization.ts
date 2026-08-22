const MAX_CHANNEL_TEXT_BYTES = 256 * 1024;
const REDACTION = "[REDACTED]";

interface CredentialPattern {
  readonly pattern: RegExp;
  readonly prefixGroup?: number;
}

const credentialPatterns: readonly CredentialPattern[] = [
  { pattern: /\b(Bearer\s+)([A-Za-z0-9._~+\/-]{8,}={0,2})/gi, prefixGroup: 1 },
  {
    pattern: /\b((?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*["']?)([^\s"'`,;]{4,})/gi,
    prefixGroup: 1,
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

function replaceLoneSurrogates(input: string): string {
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += input[index] ?? "";
        output += input[index + 1] ?? "";
        index += 1;
      } else {
        output += "\ufffd";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\ufffd";
      continue;
    }
    output += input[index] ?? "";
  }
  return output;
}

export interface SanitizedChannelText {
  readonly text: string;
  readonly redactionCount: number;
}

export function sanitizeChannelText(input: string): SanitizedChannelText {
  const byteLength = Buffer.byteLength(input, "utf8");
  if (byteLength > MAX_CHANNEL_TEXT_BYTES) {
    throw new Error(`Channel message exceeds ${MAX_CHANNEL_TEXT_BYTES} UTF-8 bytes`);
  }

  let text = replaceLoneSurrogates(input).replaceAll("\u0000", "\ufffd");
  let redactionCount = 0;

  for (const { pattern, prefixGroup } of credentialPatterns) {
    text = text.replace(pattern, (...args: unknown[]) => {
      redactionCount += 1;
      const prefix = prefixGroup === undefined || typeof args[prefixGroup] !== "string"
        ? ""
        : String(args[prefixGroup]);
      return `${prefix}${REDACTION}`;
    });
  }

  return Object.freeze({ text, redactionCount });
}

export function sanitizeDisplayText(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  return sanitizeChannelText(input).text.slice(0, 256);
}
