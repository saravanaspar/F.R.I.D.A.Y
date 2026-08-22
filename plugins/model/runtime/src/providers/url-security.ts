/**
 * URL helpers for provider compatibility/security decisions.
 * Host matching always uses a parsed hostname and a DNS-label boundary.
 */
export function normalizedUrlHostname(value: string): string | undefined {
	const raw = value.trim();
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		let hostname = url.hostname.toLowerCase();
		while (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
		return hostname || undefined;
	} catch {
		return undefined;
	}
}

export function hostnameMatches(hostname: string | undefined, expectedDomain: string): boolean {
	if (!hostname) return false;
	let expected = expectedDomain.trim().toLowerCase();
	while (expected.endsWith(".")) expected = expected.slice(0, -1);
	if (!expected) return false;
	return hostname === expected || hostname.endsWith(`.${expected}`);
}

export function urlHostnameMatches(value: string, expectedDomain: string): boolean {
	return hostnameMatches(normalizedUrlHostname(value), expectedDomain);
}

export function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
	return value.slice(0, end);
}
