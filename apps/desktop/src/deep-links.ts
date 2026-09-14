export type DesktopDeepLink =
  | { readonly kind: "conversation"; readonly id: string }
  | { readonly kind: "job"; readonly id: string }
  | { readonly kind: "artifact"; readonly id: string }
  | { readonly kind: "computer"; readonly screenLeaseId?: string }
  | { readonly kind: "settings" };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function parseDesktopDeepLink(value: string): DesktopDeepLink | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "friday:") return undefined;
  const parts = [url.host, ...url.pathname.split("/").filter(Boolean)].filter(Boolean);
  const id = parts[1];
  if (parts.length === 1 && parts[0] === "settings") return { kind: "settings" };
  if (parts.length < 2 || !id || !ID.test(id)) return parts[0] === "computer" && parts.length === 1 ? { kind: "computer" } : undefined;
  if (parts[0] === "conversation") return { kind: "conversation", id };
  if (parts[0] === "job") return { kind: "job", id };
  if (parts[0] === "artifact") return { kind: "artifact", id };
  if (parts[0] === "computer") return { kind: "computer", screenLeaseId: id };
  return undefined;
}
