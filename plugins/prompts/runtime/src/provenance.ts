import type { PromptSection, PromptSectionAuthority } from "./types.js";

export const PROMPT_SECTION_AUTHORITY_ORDER: readonly PromptSectionAuthority[] = [
  "core-policy",
  "host-policy",
  "user-config",
  "project-guidance",
  "runtime-context",
  "untrusted-data",
];

const FRIDAY_PROMPT_SECTION_TAG = "friday_prompt_section";
const FRIDAY_HOST_TAG_PREFIX = "friday_";

export function renderPromptSection(section: PromptSection): string {
  const content = section.authority === "core-policy" || section.authority === "host-policy"
    ? escapeReservedPromptSectionTags(section.content)
    : escapeReservedFridayHostTags(section.content);
  return [
    `<friday_prompt_section id="${escapeXmlAttribute(section.id)}" authority="${section.authority}" cache="${section.cache}">`,
    content,
    "</friday_prompt_section>",
  ].join("\n");
}

export function renderPromptSections(sections: readonly PromptSection[]): string {
  if (sections.length === 0) return "";
  const ordered = [...sections].sort((left, right) => {
    const byAuthority = PROMPT_SECTION_AUTHORITY_ORDER.indexOf(left.authority)
      - PROMPT_SECTION_AUTHORITY_ORDER.indexOf(right.authority);
    return byAuthority !== 0 ? byAuthority : 0;
  });
  return ordered.map(renderPromptSection).join("\n\n");
}

function escapeReservedPromptSectionTags(value: string): string {
  return escapeReservedTagOpeners(value, (input, tagNameStart) => {
    if (!matchesAsciiCaseInsensitive(input, tagNameStart, FRIDAY_PROMPT_SECTION_TAG)) return false;
    const afterTagName = tagNameStart + FRIDAY_PROMPT_SECTION_TAG.length;
    return afterTagName === input.length || !isAsciiWord(input.charCodeAt(afterTagName));
  });
}

function escapeReservedFridayHostTags(value: string): string {
  return escapeReservedTagOpeners(value, (input, tagNameStart) => {
    if (!matchesAsciiCaseInsensitive(input, tagNameStart, FRIDAY_HOST_TAG_PREFIX)) return false;

    let cursor = tagNameStart + FRIDAY_HOST_TAG_PREFIX.length;
    let sawWordCharacter = false;
    while (cursor < input.length && isFridayHostTagNameCharacter(input.charCodeAt(cursor))) {
      if (isAsciiWord(input.charCodeAt(cursor))) sawWordCharacter = true;
      cursor += 1;
    }
    return sawWordCharacter;
  });
}

function escapeReservedTagOpeners(
  value: string,
  isReservedTagName: (input: string, tagNameStart: number) => boolean,
): string {
  let pieces: string[] | undefined;
  let copyStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3c) continue; // <
    const tagNameStart = findTagNameStart(value, index + 1);
    if (tagNameStart === undefined || !isReservedTagName(value, tagNameStart)) continue;

    pieces ??= [];
    pieces.push(value.slice(copyStart, index), "&lt;");
    copyStart = index + 1;
  }

  if (pieces === undefined) return value;
  pieces.push(value.slice(copyStart));
  return pieces.join("");
}

function findTagNameStart(value: string, start: number): number | undefined {
  let cursor = skipEcmaWhitespace(value, start);
  if (value.charCodeAt(cursor) === 0x2f) { // /
    cursor = skipEcmaWhitespace(value, cursor + 1);
  }
  return cursor < value.length ? cursor : undefined;
}

function skipEcmaWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && isEcmaWhitespace(value.charCodeAt(cursor))) cursor += 1;
  return cursor;
}

function matchesAsciiCaseInsensitive(value: string, start: number, expectedLowercase: string): boolean {
  if (start + expectedLowercase.length > value.length) return false;
  for (let offset = 0; offset < expectedLowercase.length; offset += 1) {
    const actual = value.charCodeAt(start + offset);
    const normalized = actual >= 0x41 && actual <= 0x5a ? actual + 0x20 : actual;
    if (normalized !== expectedLowercase.charCodeAt(offset)) return false;
  }
  return true;
}

function isAsciiWord(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || code === 0x5f
    || (code >= 0x61 && code <= 0x7a);
}

function isFridayHostTagNameCharacter(code: number): boolean {
  return isAsciiWord(code) || code === 0x2d; // -
}

function isEcmaWhitespace(code: number): boolean {
  return code === 0x0009
    || code === 0x000a
    || code === 0x000b
    || code === 0x000c
    || code === 0x000d
    || code === 0x0020
    || code === 0x00a0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
