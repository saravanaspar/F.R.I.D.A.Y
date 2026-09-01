import type { Capability, Contribution } from "../capabilities/protocol.js";
import { defineCapability, defineContribution } from "../capabilities/protocol.js";
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


export interface ArtifactInputEnrichmentResult {
  /** Host-authored context derived from the persisted attachment. The underlying content remains untrusted user data. */
  readonly context?: string | undefined;
  /** Bounded context safe to persist in a durable session so restart does not repeat external processing. */
  readonly persistedContext?: string | undefined;
}

export interface ArtifactInputEnrichmentContext {
  readonly record: ArtifactRecord;
  /** Read a fresh bounded copy of the persisted attachment bytes. */
  read(): Promise<Uint8Array>;
}

/** Optional attachment processors such as Voice STT enrich the generic Artifacts input path without transport coupling. */
export interface ArtifactInputEnricher {
  readonly id: string;
  supports(record: ArtifactRecord): boolean;
  enrich(context: ArtifactInputEnrichmentContext): Promise<ArtifactInputEnrichmentResult | undefined>;
}

export const ARTIFACT_INPUT_ENRICHMENT_CONTRIBUTION: Contribution<ArtifactInputEnricher> =
  defineContribution<ArtifactInputEnricher>("artifact.input-enrichment");

export const ARTIFACTS_CAPABILITY: Capability<ArtifactService> =
  defineCapability<ArtifactService>("artifacts");
