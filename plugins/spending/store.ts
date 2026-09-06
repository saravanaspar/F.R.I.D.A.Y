import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpendingApprovalRecord, SpendingLimitSnapshot } from "./contract.js";

interface SpendingState {
  schema: 1;
  currency: "USD";
  warningRatio: number;
  dailyLimit?: number | undefined;
  projectLimits: Record<string, number>;
  sessionProjects: Record<string, string>;
  warned: Record<string, string>;
  approvals: SpendingApprovalRecord[];
}

const EMPTY: SpendingState = { schema: 1, currency: "USD", warningRatio: 0.8, projectLimits: {}, sessionProjects: {}, warned: {}, approvals: [] };

export class SpendingPolicyStore {
  readonly #path: string;
  #state: SpendingState;

  constructor(stateDir: string) {
    this.#path = join(stateDir, "policy.json");
    this.#state = this.#load();
  }

  #load(): SpendingState {
    if (!existsSync(this.#path)) return structuredClone(EMPTY);
    const directoryInfo = lstatSync(dirname(this.#path));
    const fileInfo = lstatSync(this.#path);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) throw new Error("Spending policy directory must be private");
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || (fileInfo.mode & 0o077) !== 0) throw new Error("Spending policy file must be private");
    const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<SpendingState>;
    if (parsed.schema !== 1 || parsed.currency !== "USD" || typeof parsed.warningRatio !== "number"
      || !parsed.projectLimits || typeof parsed.projectLimits !== "object" || Array.isArray(parsed.projectLimits)
      || !parsed.warned || typeof parsed.warned !== "object" || Array.isArray(parsed.warned)
      || !Array.isArray(parsed.approvals)) throw new Error("Spending policy state is malformed");
    if (!(parsed.warningRatio > 0 && parsed.warningRatio < 1)
      || (parsed.dailyLimit !== undefined && (!Number.isFinite(parsed.dailyLimit) || parsed.dailyLimit <= 0))
      || Object.entries(parsed.projectLimits).some(([key, value]) => !key || key.length > 128 || !Number.isFinite(value) || value <= 0)) {
      throw new Error("Spending policy limits are malformed");
    }
    return {
      schema: 1,
      currency: "USD",
      warningRatio: parsed.warningRatio,
      ...(parsed.dailyLimit === undefined ? {} : { dailyLimit: parsed.dailyLimit }),
      projectLimits: { ...parsed.projectLimits },
      sessionProjects: parsed.sessionProjects && typeof parsed.sessionProjects === "object" && !Array.isArray(parsed.sessionProjects) ? { ...parsed.sessionProjects } : {},
      warned: { ...parsed.warned },
      approvals: parsed.approvals.slice(-500),
    };
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.#path), 0o700);
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#state)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.#path);
    chmodSync(this.#path, 0o600);
  }

  limits(): SpendingLimitSnapshot {
    return Object.freeze({
      currency: "USD",
      warningRatio: this.#state.warningRatio,
      ...(this.#state.dailyLimit === undefined ? {} : { dailyLimit: this.#state.dailyLimit }),
      projectLimits: Object.freeze({ ...this.#state.projectLimits }),
    });
  }

  setLimit(scope: "daily" | "project", amount: number, projectKey?: string): SpendingLimitSnapshot {
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error("Spending limit must be greater than 0 and at most 1000000 USD");
    if (scope === "daily") this.#state.dailyLimit = amount;
    else {
      if (!projectKey) throw new Error("projectKey is required for a project spending limit");
      this.#state.projectLimits[projectKey] = amount;
    }
    this.#save();
    return this.limits();
  }

  clearLimit(scope: "daily" | "project", projectKey?: string): SpendingLimitSnapshot {
    if (scope === "daily") delete this.#state.dailyLimit;
    else {
      if (!projectKey) throw new Error("projectKey is required for a project spending limit");
      delete this.#state.projectLimits[projectKey];
    }
    this.#save();
    return this.limits();
  }

  shouldWarn(key: string): boolean { return this.#state.warned[key] === undefined; }
  markWarned(key: string): void { this.#state.warned[key] = new Date().toISOString(); this.#save(); }

  recordApproval(record: SpendingApprovalRecord): void {
    this.#state.approvals.push({ ...record });
    this.#state.approvals = this.#state.approvals.slice(-500);
    this.#save();
  }

  approvals(): readonly SpendingApprovalRecord[] { return Object.freeze(this.#state.approvals.map((record) => Object.freeze({ ...record }))); }

  registerSessionProject(rootSessionId: string, projectKey: string): void {
    if (this.#state.sessionProjects[rootSessionId] === projectKey) return;
    this.#state.sessionProjects[rootSessionId] = projectKey;
    this.#save();
  }

  projectSessions(projectKey: string): readonly string[] {
    return Object.freeze(Object.entries(this.#state.sessionProjects).flatMap(([sessionId, key]) => key === projectKey ? [sessionId] : []));
  }
}
