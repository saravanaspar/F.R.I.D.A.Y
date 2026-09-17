export interface DesktopCredentialBridge {
  createDeviceIdentity(name: string): Promise<{ readonly deviceId: string; readonly name: string; readonly publicKey: string } | undefined>;
  hasDeviceCredential(deviceId: string): Promise<boolean>;
  signDevicePayload(deviceId: string, payload: string): Promise<string | undefined>;
  clearDeviceCredential(deviceId: string): Promise<boolean>;
}

export interface DesktopDeviceIdentity {
  readonly deviceId: string;
  readonly name: string;
  readonly publicKey: string;
  sign(payload: string): Promise<string>;
}

function encode(bytes: ArrayBuffer): string {
  const value = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function pem(bytes: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/gu)?.join("\n") ?? base64}\n-----END PUBLIC KEY-----`;
}

function bridgedIdentity(input: { readonly deviceId: string; readonly name: string; readonly publicKey: string }, bridge: DesktopCredentialBridge): DesktopDeviceIdentity {
  return {
    ...input,
    sign: async (payload) => {
      const signature = await bridge.signDevicePayload(input.deviceId, payload);
      if (!signature) throw new Error("OS credential signing is unavailable");
      return signature;
    },
  };
}

export async function createDesktopDeviceIdentity(name: string, bridge?: DesktopCredentialBridge): Promise<DesktopDeviceIdentity> {
  if (bridge) {
    const created = await bridge.createDeviceIdentity(name);
    if (!created) throw new Error("OS credential storage is unavailable");
    return bridgedIdentity(created, bridge);
  }
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" } as Algorithm, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = pem(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const deviceId = crypto.randomUUID();
  return { deviceId, name, publicKey, sign: async (payload) => encode(await crypto.subtle.sign({ name: "Ed25519" } as Algorithm, keyPair.privateKey, new TextEncoder().encode(payload))) };
}

export async function restoreDesktopDeviceIdentity(deviceId: string, publicKey: string, bridge: DesktopCredentialBridge, name = "F.R.I.D.A.Y desktop"): Promise<DesktopDeviceIdentity | undefined> {
  if (!await bridge.hasDeviceCredential(deviceId)) return undefined;
  return bridgedIdentity({ deviceId, name, publicKey }, bridge);
}
