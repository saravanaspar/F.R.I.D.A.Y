export class GenerationsStateError extends Error {
  override readonly name = "GenerationsStateError";
}

export class GenerationsRepositoryError extends Error {
  override readonly name = "GenerationsRepositoryError";
}

export class GenerationsConflictError extends Error {
  override readonly name = "GenerationsConflictError";
}
