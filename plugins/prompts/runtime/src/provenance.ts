import type { PromptSection, PromptSectionAuthority } from "./types.js";

export const PROMPT_SECTION_AUTHORITY_ORDER: readonly PromptSectionAuthority[] = [
  "core-policy",
  "host-policy",
  "user-config",
  "project-guidance",
  "runtime-context",
  "untrusted-data",
];

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
  return value.replace(/<\s*\/?\s*friday_prompt_section\b/gi, (match) => `&lt;${match.slice(1)}`);
}

function escapeReservedFridayHostTags(value: string): string {
  return value.replace(/<\s*\/?\s*friday_[a-z0-9_-]+\b/gi, (match) => `&lt;${match.slice(1)}`);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
