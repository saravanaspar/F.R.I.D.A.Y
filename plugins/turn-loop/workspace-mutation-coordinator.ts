import { resolve } from "node:path";

/**
 * Serializes host-mediated mutation operations that target the same shared
 * Project workspace. This intentionally does not create filesystem isolation:
 * parent/child Agents still see the same files, while ordinary edit/shell/
 * project mutation tool calls cannot overlap each other accidentally.
 */
export class WorkspaceMutationCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
    const key = resolve(workspace);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const barrier = previous.then(() => undefined, () => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = barrier.then(() => gate);
    this.#tails.set(key, tail);
    await barrier;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
