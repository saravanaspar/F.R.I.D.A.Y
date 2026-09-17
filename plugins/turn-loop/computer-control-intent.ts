/**
 * Post-routing recognizer for the bounded FRIDAY-owned Computer cleanup action.
 *
 * This is deliberately downstream of Routing. The AI router decides whether a
 * human message belongs on the transient Agent path; this helper only selects
 * the host-owned cleanup implementation after that routing decision exists.
 */
export function isComputerCleanupCommand(text: string): boolean {
  let normalized = text.trim().toLowerCase().replaceAll("/", " ").replaceAll("-", " ");
  for (const prefix of ["please ", "can you ", "can u ", "could you ", "could u ", "would you ", "would u "] as const) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length).trimStart();
      break;
    }
  }
  const actions = ["clean up", "cleanup", "terminate", "cancel", "close", "kill", "stop"] as const;
  const targets = ["computer", "headless", "screen", "browser"] as const;
  const startsWithTerm = (value: string, term: string): boolean => value === term || value.startsWith(`${term} `);
  const containsTerm = (value: string, term: string): boolean => value === term
    || value.startsWith(`${term} `)
    || value.endsWith(` ${term}`)
    || value.includes(` ${term} `);
  const bounded = normalized.slice(0, 160);
  const actionFirst = actions.find((action) => startsWithTerm(bounded, action));
  if (actionFirst) {
    const rest = bounded.slice(actionFirst.length).trimStart();
    return targets.some((target) => containsTerm(rest, target));
  }
  const targetFirst = targets.find((target) => startsWithTerm(bounded, target));
  if (!targetFirst) return false;
  const rest = bounded.slice(targetFirst.length).trimStart();
  return actions.some((action) => containsTerm(rest, action));
}

/**
 * Post-routing recognizer for the read-only live Computer/browser/media status
 * fast path. Routing has already selected the Computer capability before this
 * helper can run.
 */
export function isComputerStatusQuery(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 320) return false;
  const subject = /\b(?:computer|screen|browser|page|tab|youtube|video|song|music|media|playback|it)\b/.test(normalized);
  const status = /\b(?:play|playing|paused|running|stuck|working|doing|loaded|open|started|finish|finished|status)\b/.test(normalized);
  const interrogative = /^(?:is|are|was|were|did|does|has|have|what|where|how|status\b)/.test(normalized) || normalized.endsWith("?");
  const controlCommand = /^(?:open|play|pause|resume|stop|close|kill|click|type|search|navigate|go\s+to|switch)\b/.test(normalized);
  return subject && status && interrogative && !controlCommand;
}
