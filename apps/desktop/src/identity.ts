export interface DesktopCredentialBridge {
  getCredential(key: string): Promise<string | undefined>;
  setCredential(key: string, value: string): Promise<boolean>;
  clearCredential(key: string): Promise<boolean>;
}

export interface DesktopDeviceIdentity {
  readonly deviceId: string;
  readonly name: string;
  readonly publicKey: string;
  sign(challenge: string): Promise<string>;
}

function encode(bytes: ArrayBuffer): string {
  const value = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function pem(bytes: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/gu)?.join("\n") ?? base64}\n-----END PUBLIC KEY-----`;
}

export async function createDesktopDeviceIdentity(name: string, bridge?: DesktopCredentialBridge): Promise<DesktopDeviceIdentity> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" } as Algorithm, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = pem(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const privateKey = encode(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const deviceId = crypto.randomUUID();
  if (bridge) {
    const saved = await bridge.setCredential(`device:${deviceId}`, JSON.stringify({ privateKey, name }));
    if (!saved) throw new Error("OS credential storage is unavailable");
  }
  return { deviceId, name, publicKey, sign: async (challenge) => encode(await crypto.subtle.sign({ name: "Ed25519" } as Algorithm, keyPair.privateKey, new TextEncoder().encode(challenge))) };
}

export async function restoreDesktopDeviceIdentity(deviceId: string, publicKey: string, bridge: DesktopCredentialBridge, name = "F.R.I.D.A.Y desktop"): Promise<DesktopDeviceIdentity | undefined> {
  const stored = await bridge.getCredential(`device:${deviceId}`);
  if (!stored) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(stored) as unknown; } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).privateKey !== "string") return undefined;
  const privateKey = (parsed as Record<string, unknown>).privateKey as string;
  try {
    const bytes = Uint8Array.from(atob(privateKey.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "Ed25519" } as Algorithm, false, ["sign"]);
    return { deviceId, name, publicKey, sign: async (challenge) => encode(await crypto.subtle.sign({ name: "Ed25519" } as Algorithm, key, new TextEncoder().encode(challenge))) };
  } catch { return undefined; }
}
