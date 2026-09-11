export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotGitRepositoryError extends WorktreeError {}
export class WorktreeNameError extends WorktreeError {}
export class WorktreeCreateError extends WorktreeError {}
export class WorktreeRemoveError extends WorktreeError {}
export class WorktreeResetError extends WorktreeError {}
export class WorktreeListError extends WorktreeError {}
export class WorktreeInspectError extends WorktreeError {}
export class WorktreeCommitError extends WorktreeError {}

export class WorktreePromoteError extends WorktreeError {}
