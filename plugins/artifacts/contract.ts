import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
export interface ArtifactChannelPrincipal {
  readonly authority: "local" | "channel";
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
}

export interface ArtifactAttachment {
  readonly kind: "image" | "audio" | "video" | "document" | "sticker" | "other";
  readonly externalId: string;
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly downloadUrl?: string | undefined;
  readonly artifactRef?: string | undefined;
}

export interface ArtifactRecord {
  readonly ref: string;
  readonly id: string;
  readonly fileName: string;
  readonly mimeType?: string | undefined;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface PackageStage {
  readonly sourceDir: string;
  readonly source: string;
  readonly files: number;
  readonly bytes: number;
  dispose(): Promise<void>;
}

export interface PackageSourceInput {
  readonly url?: string | undefined;
  readonly principal?: ArtifactChannelPrincipal | undefined;
  readonly attachment?: ArtifactAttachment | undefined;
  readonly maxBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ArtifactService {
  ingestChannelAttachment(
    principal: ArtifactChannelPrincipal,
    attachment: ArtifactAttachment,
    options?: { readonly maxBytes?: number | undefined },
  ): Promise<ArtifactRecord>;
  inspect(ref: string): Promise<ArtifactRecord>;
  consume<T>(ref: string, consumer: (bytes: Uint8Array, record: ArtifactRecord) => T | Promise<T>): Promise<T>;
  /** Safely materialize a user-supplied GitHub repository or ZIP source into a private temporary tree. */
  stagePackageSource(input: PackageSourceInput): Promise<PackageStage>;
}

export const ARTIFACTS_CAPABILITY: Capability<ArtifactService> =
  defineCapability<ArtifactService>("artifacts");
