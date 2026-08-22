/** Parsed skill block from a user message. */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

const SKILL_PREFIX = '<skill name="';
const LOCATION_SEPARATOR = '" location="';
const HEADER_END = '">\n';
const SKILL_CLOSE = '\n</skill>';
const USER_MESSAGE_SEPARATOR = '\n\n';

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	if (!text.startsWith(SKILL_PREFIX)) return null;

	const nameStart = SKILL_PREFIX.length;
	const locationSeparator = text.indexOf(LOCATION_SEPARATOR, nameStart);
	if (locationSeparator <= nameStart) return null;
	const name = text.slice(nameStart, locationSeparator);
	if (!name || name.includes('"')) return null;

	const locationStart = locationSeparator + LOCATION_SEPARATOR.length;
	const headerEnd = text.indexOf(HEADER_END, locationStart);
	if (headerEnd <= locationStart) return null;
	const location = text.slice(locationStart, headerEnd);
	if (!location || location.includes('"')) return null;

	const contentStart = headerEnd + HEADER_END.length;
	const close = text.lastIndexOf(SKILL_CLOSE);
	if (close < contentStart) return null;
	const content = text.slice(contentStart, close);

	const remainder = text.slice(close + SKILL_CLOSE.length);
	if (!remainder) {
		return { name, location, content, userMessage: undefined };
	}
	if (!remainder.startsWith(USER_MESSAGE_SEPARATOR)) return null;
	const userMessage = remainder.slice(USER_MESSAGE_SEPARATOR.length).trim() || undefined;

	return { name, location, content, userMessage };
}
