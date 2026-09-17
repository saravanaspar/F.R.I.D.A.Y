import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDevicesService } from "../plugins/devices/index.js";

const roots: string[] = [];
const originalStateDir = process.env.FRIDAY_STATE_DIR;

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = originalStateDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function paired(role: "operator" | "read-only" = "operator") {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-device-security-"));
  roots.push(stateDir);
  process.env.FRIDAY_STATE_DIR = stateDir;
  const service = createDevicesService();
  const keys = generateKeyPairSync("ed25519");
  const pairing = await service.beginPairing({
    deviceId: "desktop-security",
    name: "Desktop security",
    type: "desktop",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  const record = await service.approvePairing(pairing.pairingId, { role });
  return { service, keys, record };
}

describe("device authentication security", () => {
  it("keeps at most one pending pairing per device id", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-device-pairing-dedup-"));
    roots.push(stateDir);
    process.env.FRIDAY_STATE_DIR = stateDir;
    const service = createDevicesService();
    const keys = generateKeyPairSync("ed25519");
    const descriptor = {
      deviceId: "desktop-pairing-dedup",
      name: "Desktop pairing dedup",
      type: "desktop" as const,
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };

    const first = await service.beginPairing(descriptor);
    const second = await service.beginPairing(descriptor);

    expect(second.pairingId).not.toBe(first.pairingId);
    expect(service.pendingPairings()).toHaveLength(1);
    expect(service.pendingPairings()[0]?.pairingId).toBe(second.pairingId);
  });

  it("persists the explicit paired-device role", async () => {
    const { record, service } = await paired("read-only");
    expect(record.role).toBe("read-only");
    expect(service.devices()[0]?.role).toBe("read-only");
  });

  it("keeps multiple in-flight authentication challenges valid until each is consumed", async () => {
    const { service, keys } = await paired();
    const first = await service.issueChallenge("desktop-security");
    const second = await service.issueChallenge("desktop-security");
    const firstPayload = `friday-client-auth-v1:first-${first.challenge}`;
    const secondPayload = `friday-client-auth-v1:second-${second.challenge}`;

    await expect(service.authenticate(
      "desktop-security",
      first.challenge,
      sign(null, Buffer.from(firstPayload), keys.privateKey).toString("base64url"),
      firstPayload,
    )).resolves.toMatchObject({ role: "operator" });
    await expect(service.authenticate(
      "desktop-security",
      second.challenge,
      sign(null, Buffer.from(secondPayload), keys.privateKey).toString("base64url"),
      secondPayload,
    )).resolves.toMatchObject({ role: "operator" });
  });

  it("bounds outstanding authentication challenges per device", async () => {
    const { service } = await paired();
    for (let index = 0; index < 8; index += 1) await service.issueChallenge("desktop-security");
    await expect(service.issueChallenge("desktop-security")).rejects.toThrow(/too many outstanding/i);
  });

  it("verifies a request-bound signing payload instead of the challenge alone", async () => {
    const { service, keys } = await paired();
    const challenge = await service.issueChallenge("desktop-security");
    const payload = `friday-client-auth-v1:request-bound-${challenge.challenge}`;
    const signature = sign(null, Buffer.from(payload), keys.privateKey).toString("base64url");
    await expect(service.authenticate("desktop-security", challenge.challenge, signature, payload)).resolves.toMatchObject({ role: "operator" });

    const next = await service.issueChallenge("desktop-security");
    const challengeOnly = sign(null, Buffer.from(next.challenge), keys.privateKey).toString("base64url");
    await expect(service.authenticate("desktop-security", next.challenge, challengeOnly, `${payload}-different`)).rejects.toThrow(/signature/i);
  });
});
