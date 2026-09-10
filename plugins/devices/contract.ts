import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type DeviceType = "desktop" | "android" | "computer-node" | "test";

export interface DeviceDescriptor {
  readonly deviceId: string;
  readonly name: string;
  readonly type: DeviceType;
  readonly publicKey: string;
}

export interface DeviceRecord extends DeviceDescriptor {
  readonly pairedAt: string;
  readonly lastSeenAt?: string | undefined;
  readonly revokedAt?: string | undefined;
}

export interface PairingRequest {
  readonly pairingId: string;
  readonly device: DeviceDescriptor;
  readonly challenge: string;
  readonly expiresAt: string;
}

export interface DevicesService {
  beginPairing(device: DeviceDescriptor, options?: { readonly ttlMs?: number | undefined }): Promise<PairingRequest>;
  approvePairing(pairingId: string): Promise<DeviceRecord>;
  pendingPairings(): readonly PairingRequest[];
  devices(): readonly DeviceRecord[];
  issueChallenge(deviceId: string): Promise<{ readonly challenge: string; readonly expiresAt: string }>;
  authenticate(deviceId: string, challenge: string, signature: string): Promise<DeviceRecord>;
  revoke(deviceId: string): Promise<boolean>;
}

export const DEVICES_CAPABILITY: Capability<DevicesService> = defineCapability<DevicesService>("devices");
