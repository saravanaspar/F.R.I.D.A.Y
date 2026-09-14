export interface DesktopStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
}

export function createDesktopStorage(storage: Storage | undefined = typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage): DesktopStorage {
  return {
    get<T>(key: string) {
      if (!storage) return undefined;
      try {
        const raw = storage.getItem(`friday.desktop.${key}`);
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).version === 1
          ? (parsed as Record<string, unknown>).value as T
          : undefined;
      } catch { return undefined; }
    },
    set<T>(key: string, value: T) {
      if (!storage) return;
      try { storage.setItem(`friday.desktop.${key}`, JSON.stringify({ version: 1, value })); } catch { /* cache is best effort */ }
    },
    remove(key: string) { storage?.removeItem(`friday.desktop.${key}`); },
  };
}
