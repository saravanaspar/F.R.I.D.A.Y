import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { ObservabilityLogRecord, ObservabilitySpanRecord } from "../observability/contract.js";
import type { DoctorCheck } from "../host-doctor/contract.js";

export type DiagnosticDoctorCheck = DoctorCheck;

export interface DiagnosticSetupRecord {
  readonly at?: string | undefined;
  readonly component?: string | undefined;
  readonly operation?: string | undefined;
  readonly outcome?: "started" | "success" | "failure" | undefined;
  readonly message?: string | undefined;
  readonly durationMs?: number | undefined;
}

export interface DiagnosticCrashRecord {
  readonly at?: string | undefined;
  readonly operation?: string | undefined;
  readonly errorName?: string | undefined;
  readonly message?: string | undefined;
  readonly fingerprint?: string | undefined;
  readonly consecutiveCount?: number | undefined;
  readonly restartStorm?: boolean | undefined;
}

export interface DiagnosticsBundle {
  readonly generatedAt: string;
  readonly doctor: readonly DiagnosticDoctorCheck[];
  readonly runtime: unknown;
  readonly statuses: Readonly<Record<string, string>>;
  readonly logs: readonly ObservabilityLogRecord[];
  readonly spans: readonly ObservabilitySpanRecord[];
  readonly crashes: readonly DiagnosticCrashRecord[];
  readonly setup: readonly DiagnosticSetupRecord[];
  readonly suggestedActions: readonly string[];
}

export interface DiagnosticsService {
  doctor(): Promise<readonly DiagnosticDoctorCheck[]>;
  review(options?: { readonly component?: string | undefined; readonly limit?: number | undefined }): Promise<DiagnosticsBundle>;
}

export const DIAGNOSTICS_CAPABILITY: Capability<DiagnosticsService> =
  defineCapability<DiagnosticsService>("diagnostics");
