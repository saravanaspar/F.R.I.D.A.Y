export type SessionResourceCleanup = (sessionId?: string) => void | Promise<void>;

export interface SessionResourceAccess {
  registerSessionResourceCleanup(cleanup: SessionResourceCleanup): void;
}

let access: SessionResourceAccess | undefined;
const pendingCleanups: SessionResourceCleanup[] = [];

/** Inject session-scoped lifecycle cleanup without coupling this runtime to a sibling package. */
export function configureSessionResourceAccess(next: SessionResourceAccess): void {
  access = next;
  for (const cleanup of pendingCleanups.splice(0)) {
    next.registerSessionResourceCleanup(cleanup);
  }
}

/** Runtime modules may register cleanup during module evaluation; registration is wired once the plugin activates. */
export function registerExecutionResourceCleanup(cleanup: SessionResourceCleanup): void {
  if (access) {
    access.registerSessionResourceCleanup(cleanup);
    return;
  }
  pendingCleanups.push(cleanup);
}
