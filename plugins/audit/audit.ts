import type { AuditQuery, AuditRecordInput, AuditService } from "./contract.js";
import type { AuditTrustedService } from "./trusted-contract.js";
import { AuditDatabase, getAuditStateDir } from "./store.js";

export interface AuditServiceOptions {
  readonly stateDir?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly randomBytes?: ((size: number) => Buffer) | undefined;
}

export interface AuditController {
  readonly audit: AuditService;
  readonly trusted: AuditTrustedService;
  close(): void;
}

export function createAuditController(options: AuditServiceOptions = {}): AuditController {
  const database = new AuditDatabase({
    stateDir: options.stateDir ?? getAuditStateDir(),
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  });

  const audit: AuditService = Object.freeze({
    records: (query?: AuditQuery) => database.records(query),
    verify: () => database.verify(),
    status: () => database.status(),
  });

  const trusted: AuditTrustedService = Object.freeze({
    append: (input: AuditRecordInput) => database.append(input),
  });

  let closed = false;
  return Object.freeze({
    audit,
    trusted,
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}
