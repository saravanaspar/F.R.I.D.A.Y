export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
  path: string;
  source: string;
  scope: SourceScope;
  origin: SourceOrigin;
  baseDir?: string;
}

export function createSyntheticSourceInfo(
  path: string,
  options: {
    source: string;
    scope?: SourceScope;
    origin?: SourceOrigin;
    baseDir?: string;
  },
): SourceInfo {
  return {
    path,
    source: options.source,
    scope: options.scope ?? "temporary",
    origin: options.origin ?? "top-level",
    baseDir: options.baseDir,
  };
}
