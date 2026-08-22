declare const __FRIDAY_VERSION__: string | undefined;

const injected = typeof __FRIDAY_VERSION__ === "string" ? __FRIDAY_VERSION__.trim() : "";
const configured = process.env.FRIDAY_BUILD_VERSION?.trim() || process.env.FRIDAY_VERSION?.trim() || "";

/** User-visible FRIDAY build/release version. Release binaries inject the exact tag version. */
export const FRIDAY_VERSION = injected || configured || "0.1.0-dev";

// Plugin runtimes cannot import host src/ modules across the architecture boundary.
// Publish the resolved host version through process environment for protocol metadata.
if (!process.env.FRIDAY_VERSION?.trim()) process.env.FRIDAY_VERSION = FRIDAY_VERSION;
