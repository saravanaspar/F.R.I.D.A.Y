import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { reportOperationalError } from "@friday/operational-errors";
import { dirname, join, resolve } from "node:path";
import { getFridayHome } from "./runtime-env.js";

export type OnboardingMode = "quick" | "custom";
export type OnboardingStepStatus = "pending" | "complete" | "skipped";
export type OnboardingPhase = "local-bootstrap" | "remote-onboarding" | "operational";

export const ONBOARDING_MANDATORY_STEPS = Object.freeze([
  "router",
  "operatorChannel",
  "privilegePolicy",
] as const);

export const ONBOARDING_OPTIONAL_STEPS = Object.freeze([
  "mainModel",
  "permissions",
  "timezone",
  "voice",
  "sandbox",
  "executionPython",
  "mcp",
  "skills",
  "selfRepository",
] as const);

export const ONBOARDING_STEPS = Object.freeze([
  ...ONBOARDING_MANDATORY_STEPS,
  ...ONBOARDING_OPTIONAL_STEPS,
] as const);

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingState {
  readonly schema: 1;
  readonly mode: OnboardingMode;
  readonly phase: OnboardingPhase;
  readonly updatedAt: string;
  readonly steps: Readonly<Record<OnboardingStepId, OnboardingStepStatus>>;
}

const STATUS = new Set<OnboardingStepStatus>(["pending", "complete", "skipped"]);
const MODES = new Set<OnboardingMode>(["quick", "custom"]);

function onboardingPath(home = getFridayHome()): string {
  return join(resolve(home), "onboarding", "state.json");
}

function phaseFor(steps: Readonly<Record<OnboardingStepId, OnboardingStepStatus>>): OnboardingPhase {
  if (ONBOARDING_MANDATORY_STEPS.some((step) => steps[step] !== "complete")) return "local-bootstrap";
  if (ONBOARDING_OPTIONAL_STEPS.some((step) => steps[step] === "pending")) return "remote-onboarding";
  return "operational";
}

function defaultSteps(): Record<OnboardingStepId, OnboardingStepStatus> {
  return Object.fromEntries(ONBOARDING_STEPS.map((step) => [step, "pending"])) as Record<OnboardingStepId, OnboardingStepStatus>;
}

function normalizedState(value: unknown): OnboardingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("onboarding state must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 1) throw new Error("unsupported onboarding state schema");
  if (typeof raw.mode !== "string" || !MODES.has(raw.mode as OnboardingMode)) throw new Error("onboarding mode is invalid");
  if (!raw.steps || typeof raw.steps !== "object" || Array.isArray(raw.steps)) throw new Error("onboarding steps are invalid");
  const input = raw.steps as Record<string, unknown>;
  const steps = defaultSteps();
  for (const step of ONBOARDING_STEPS) {
    const status = input[step];
    if (typeof status !== "string" || !STATUS.has(status as OnboardingStepStatus)) throw new Error(`onboarding step ${step} is invalid`);
    if ((ONBOARDING_MANDATORY_STEPS as readonly string[]).includes(step) && status === "skipped") {
      throw new Error(`mandatory onboarding step ${step} cannot be skipped`);
    }
    steps[step] = status as OnboardingStepStatus;
  }
  const updatedAt = typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt))
    ? raw.updatedAt
    : new Date(0).toISOString();
  return Object.freeze({
    schema: 1,
    mode: raw.mode as OnboardingMode,
    phase: phaseFor(steps),
    updatedAt,
    steps: Object.freeze(steps),
  });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`onboarding state directory is unsafe: ${path}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(path, info.mode & ~0o077);
}

export function createOnboardingState(mode: OnboardingMode): OnboardingState {
  const steps = defaultSteps();
  return Object.freeze({
    schema: 1,
    mode,
    phase: phaseFor(steps),
    updatedAt: new Date().toISOString(),
    steps: Object.freeze(steps),
  });
}

export async function readOnboardingState(home = getFridayHome()): Promise<OnboardingState | undefined> {
  const path = onboardingPath(home);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`onboarding state path is unsafe: ${path}`);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error(`onboarding state permissions are too broad: ${path}`);
    return normalizedState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveOnboardingState(state: OnboardingState, home = getFridayHome()): Promise<OnboardingState> {
  const normalized = normalizedState(state);
  const path = onboardingPath(home);
  await ensurePrivateDirectory(dirname(path));
  const next: OnboardingState = Object.freeze({
    ...normalized,
    phase: phaseFor(normalized.steps),
    updatedAt: new Date().toISOString(),
  });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      reportOperationalError({ component: "onboarding", operation: "remove failed onboarding state write", error: cleanupError, severity: "warn", outcome: "degraded" });
    }
    throw error;
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
  return next;
}

export async function initializeOnboardingState(mode: OnboardingMode, home = getFridayHome()): Promise<OnboardingState> {
  const current = await readOnboardingState(home);
  if (current) {
    if (current.mode === mode) return current;
    return saveOnboardingState(Object.freeze({ ...current, mode }), home);
  }
  return saveOnboardingState(createOnboardingState(mode), home);
}

export async function updateOnboardingStep(
  step: OnboardingStepId,
  status: OnboardingStepStatus,
  home = getFridayHome(),
): Promise<OnboardingState> {
  if (!ONBOARDING_STEPS.includes(step)) throw new Error(`unknown onboarding step: ${step}`);
  if ((ONBOARDING_MANDATORY_STEPS as readonly string[]).includes(step) && status === "skipped") {
    throw new Error(`mandatory onboarding step ${step} cannot be skipped`);
  }
  const current = await readOnboardingState(home) ?? createOnboardingState("quick");
  const steps = { ...current.steps, [step]: status } as Record<OnboardingStepId, OnboardingStepStatus>;
  return saveOnboardingState(Object.freeze({ ...current, steps: Object.freeze(steps) }), home);
}

export function onboardingNextSteps(state: OnboardingState): readonly OnboardingStepId[] {
  return Object.freeze(ONBOARDING_STEPS.filter((step) => state.steps[step] === "pending"));
}
