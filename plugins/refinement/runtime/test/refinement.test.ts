import { afterEach, describe, expect, it } from "vitest";
import {
  REFINEMENT_CUSTOM_TYPE,
  applyRefinementProposal,
  buildAutoRefineReviewUserPrompt,
  buildRefinementUserPrompt,
  buildRollbackProposal,
  getRefinementHistory,
  inferRefinementResultScope,
  installMemoryAccess,
  installModelAccess,
  openMemory,
  parseAutoRefineReview,
  parseProposal,
  planRefinement,
  refine,
  reviewAutoRefine,
  TRUNCATED_JSON_ERROR,
  uninstallMemoryAccess,
  uninstallModelAccess,
  validateRefinementEdit,
  type RefinementEntry,
  type RefinementKind,
  type RefinementMemoryPort,
  type RefinementResult,
  type RefinementState,
} from "../src/index.js";

function emptyState(): RefinementState {
  return {
    schema: 1,
    entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
    refinements: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ownEntry(state: RefinementState, kind: RefinementKind, id: string): RefinementEntry | undefined {
  const entries = state.entries[kind];
  return Object.hasOwn(entries, id) ? entries[id] : undefined;
}

function setOwnEntry(state: RefinementState, kind: RefinementKind, id: string, entry: RefinementEntry): void {
  Object.defineProperty(state.entries[kind], id, {
    value: entry,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function deleteOwnEntry(state: RefinementState, kind: RefinementKind, id: string): boolean {
  const entries = state.entries[kind];
  if (!Object.hasOwn(entries, id)) return false;
  return Reflect.deleteProperty(entries, id);
}

class FakeMemory implements RefinementMemoryPort {
  readonly scope: "local" | "global";
  #state: RefinementState;

  constructor(scope: "local" | "global" = "local", state = emptyState()) {
    this.scope = scope;
    this.#state = clone(state);
  }

  snapshot(): RefinementState {
    return clone(this.#state);
  }

  get(kind: RefinementKind, id: string): RefinementEntry | undefined {
    const entry = ownEntry(this.#state, kind, id);
    return entry ? clone(entry) : undefined;
  }

  create(
    kind: RefinementKind,
    input: {
      id?: string;
      title: string;
      content: string;
      path?: string;
      reference?: Record<string, unknown>;
      arguments?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      source?: string;
    },
  ): RefinementEntry {
    const id = input.id ?? input.title.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (ownEntry(this.#state, kind, id)) throw new Error("exists");
    const now = new Date(0).toISOString();
    const entry: RefinementEntry = {
      id,
      kind,
      title: input.title,
      content: input.content,
      path: input.path ?? "general",
      scope: this.scope,
      reference: clone(input.reference ?? {}),
      arguments: clone(input.arguments ?? {}),
      metadata: clone(input.metadata ?? {}),
      source: input.source ?? "agent",
      created_at: now,
      updated_at: now,
      version: 1,
    };
    setOwnEntry(this.#state, kind, id, entry);
    return clone(entry);
  }

  update(
    kind: RefinementKind,
    id: string,
    input: {
      title: string;
      content: string;
      path?: string;
      reference?: Record<string, unknown>;
      arguments?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      source?: string;
    },
  ): RefinementEntry {
    const existing = ownEntry(this.#state, kind, id);
    if (!existing) throw new Error("missing");
    const next: RefinementEntry = {
      ...existing,
      title: input.title,
      content: input.content,
      path: input.path ?? existing.path,
      reference: clone(input.reference ?? existing.reference),
      arguments: clone(input.arguments ?? existing.arguments),
      metadata: clone(input.metadata ?? existing.metadata),
      source: input.source ?? existing.source,
      updated_at: new Date(existing.version * 1000).toISOString(),
      version: existing.version + 1,
    };
    setOwnEntry(this.#state, kind, id, next);
    return clone(next);
  }

  delete(kind: RefinementKind, id: string): boolean {
    return deleteOwnEntry(this.#state, kind, id);
  }

  recordRefinement(
    trigger: string,
    changes: readonly string[] | string,
    options: { id?: string; evidence?: string; outcome?: string } = {},
  ) {
    const event = {
      id: options.id ?? "refine_1",
      trigger,
      changes: typeof changes === "string" ? [changes] : [...changes],
      evidence: options.evidence ?? "",
      outcome: options.outcome ?? "",
      created_at: new Date(0).toISOString(),
    };
    this.#state.refinements.push(event);
    return clone(event);
  }

  mutate(kind: RefinementKind, id: string, content: string): void {
    const entry = ownEntry(this.#state, kind, id);
    if (!entry) throw new Error("missing");
    entry.content = content;
    entry.version += 1;
  }
}

function proposal(edits: Parameters<typeof applyRefinementProposal>[1]["edits"], summary = "Improve state") {
  return {
    summary,
    rationale: "Repeated evidence supports the change.",
    expectedOutcome: "Future turns reuse the lesson.",
    edits,
  };
}

function seed(store: FakeMemory, kind: RefinementKind = "memory", id = "lesson"): RefinementEntry {
  return store.create(kind, {
    id,
    title: `${kind} title`,
    content: `${kind} content`,
    ...(kind === "skill"
      ? {
          reference: { type: "python", import: "skills.check", callable: "check" },
          arguments: {},
        }
      : {}),
  });
}

function model(maxTokens = 12_000) {
  return { maxTokens };
}

function completion(text: string, stopReason: "stop" | "length" | "error" | "aborted" = "stop") {
  return {
    content: [{ type: "text" as const, text }],
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
  };
}

afterEach(() => {
  uninstallModelAccess();
  uninstallMemoryAccess();
});

describe("refinement JSON", () => {
  it("parses plain JSON proposals", () => {
    const parsed = parseProposal(
      JSON.stringify({
        summary: "Remember it",
        rationale: "Repeated",
        expectedOutcome: "Reuse",
        edits: [{ action: "create", kind: "memory", title: "Fact", content: "Value" }],
      }),
    );
    expect(parsed.edits[0]).toMatchObject({ action: "create", kind: "memory", title: "Fact" });
  });

  it("recovers fenced and prose-wrapped JSON", () => {
    expect(parseProposal('```json\n{"summary":"A","edits":[]}\n```').summary).toBe("A");
    expect(parseProposal('result: {"summary":"B","edits":[]} done').summary).toBe("B");
  });

  it("diagnoses truncated JSON separately from malformed JSON", () => {
    expect(() => parseProposal('{"summary":"x","edits":[')).toThrow(TRUNCATED_JSON_ERROR);
    expect(() => parseProposal('{"summary": nope}')).toThrow("valid JSON");
  });

  it("parses automatic review JSON with optional instructions", () => {
    expect(
      parseAutoRefineReview('{"shouldRefine":true,"rationale":"useful","instructions":"focus on tests"}'),
    ).toEqual({ shouldRefine: true, rationale: "useful", instructions: "focus on tests" });
    expect(parseAutoRefineReview('{"shouldRefine":false}')).toEqual({
      shouldRefine: false,
      rationale: "No rationale provided.",
    });
  });
});

describe("edit validation", () => {
  it("protects the immutable base prompt and requires ids for mutation", () => {
    expect(
      validateRefinementEdit({
        action: "create",
        kind: "prompt",
        id: "base_system_prompt",
        title: "Base",
        content: "replace",
      }),
    ).toBe("base system prompt is not editable");
    expect(validateRefinementEdit({ action: "delete", kind: "memory" })).toBe("delete requires id");
  });

  it("rejects object-prototype refinement ids", () => {
    for (const id of ["__proto__", "prototype", "constructor"]) {
      expect(
        validateRefinementEdit({ action: "create", kind: "memory", id, title: "Unsafe", content: "x" }, id),
      ).toBe("reserved refinement id");
    }
  });

  it("requires title and content for create/update", () => {
    expect(validateRefinementEdit({ action: "create", kind: "memory", title: "Only title" })).toBe(
      "create requires title and content",
    );
  });

  it("requires explicit arguments and Python references for skills", () => {
    expect(
      validateRefinementEdit({ action: "create", kind: "skill", title: "S", content: "C" }),
    ).toBe("create skill requires arguments");
    expect(
      validateRefinementEdit({ action: "create", kind: "skill", title: "S", content: "C", arguments: {} }),
    ).toBe("create skill requires python reference");
    expect(
      validateRefinementEdit({
        action: "create",
        kind: "skill",
        title: "S",
        content: "C",
        arguments: {},
        reference: { type: "http" },
      }),
    ).toBe("create skill reference.type must be python");
  });
});

describe("proposal application", () => {
  it("creates, updates, and deletes through the memory port", () => {
    const store = new FakeMemory();
    const created = applyRefinementProposal(
      store,
      proposal([
        { action: "create", kind: "memory", id: "lesson", title: "Lesson", content: "first" },
        {
          action: "create",
          kind: "skill",
          id: "check",
          title: "Check",
          content: "run check",
          reference: { type: "python", import: "skills.check", callable: "check" },
          arguments: {},
        },
      ]),
      { id: "r1", scope: "local" },
    );
    expect(created.appliedEdits.every((edit) => edit.applied)).toBe(true);
    expect(store.get("memory", "lesson")?.source).toBe("refinement");

    const updated = applyRefinementProposal(
      store,
      proposal([{ action: "update", kind: "memory", id: "lesson", title: "Lesson", content: "second" }]),
      { id: "r2" },
    );
    expect(updated.appliedEdits[0]?.after?.version).toBe(2);
    expect(store.get("memory", "lesson")?.content).toBe("second");

    const deleted = applyRefinementProposal(
      store,
      proposal([{ action: "delete", kind: "memory", id: "lesson" }]),
      { id: "r3" },
    );
    expect(deleted.appliedEdits[0]?.before?.content).toBe("second");
    expect(store.get("memory", "lesson")).toBeUndefined();
  });

  it("generates bounded ids and preserves omitted fields on update", () => {
    const store = new FakeMemory();
    const created = applyRefinementProposal(
      store,
      proposal([{ action: "create", kind: "memory", title: "Native Check!", content: "first", path: "x" }]),
      { id: "r1" },
    );
    expect(created.appliedEdits[0]?.id).toBe("native_check");
    applyRefinementProposal(
      store,
      proposal([{ action: "update", kind: "memory", id: "native_check", title: "Native Check", content: "next" }]),
      { id: "r2" },
    );
    expect(store.get("memory", "native_check")?.path).toBe("x");
  });

  it("rejects missing targets and duplicate creates", () => {
    const store = new FakeMemory();
    seed(store);
    const result = applyRefinementProposal(
      store,
      proposal([
        { action: "create", kind: "memory", id: "lesson", title: "Again", content: "again" },
        { action: "update", kind: "memory", id: "missing", title: "Missing", content: "x" },
        { action: "delete", kind: "memory", id: "also_missing" },
      ]),
      { id: "r1" },
    );
    expect(result.appliedEdits.map((edit) => edit.error)).toEqual([
      "entry already exists",
      "entry not found",
      "entry not found",
    ]);
  });

  it("rejects a stale plan when the entry changed after planning", () => {
    const store = new FakeMemory();
    seed(store);
    const baseline = store.snapshot();
    store.mutate("memory", "lesson", "external change");
    const result = applyRefinementProposal(
      store,
      proposal([{ action: "update", kind: "memory", id: "lesson", title: "Lesson", content: "stale" }]),
      { id: "r1", baselineState: baseline },
    );
    expect(result.appliedEdits[0]).toMatchObject({
      applied: false,
      error: "entry changed during refinement planning",
    });
    expect(store.get("memory", "lesson")?.content).toBe("external change");
  });

  it("allows sequential edits to the same entry after one baseline match", () => {
    const store = new FakeMemory();
    seed(store);
    const baseline = store.snapshot();
    const result = applyRefinementProposal(
      store,
      proposal([
        { action: "update", kind: "memory", id: "lesson", title: "First", content: "one" },
        { action: "update", kind: "memory", id: "lesson", title: "Second", content: "two" },
      ]),
      { id: "r1", baselineState: baseline },
    );
    expect(result.appliedEdits.map((edit) => edit.applied)).toEqual([true, true]);
    expect(store.get("memory", "lesson")?.version).toBe(3);
  });

  it("records a passive refinement event through memory", () => {
    const store = new FakeMemory();
    applyRefinementProposal(
      store,
      proposal([{ action: "create", kind: "memory", id: "lesson", title: "Lesson", content: "x" }], "Remember"),
      { id: "refine_9" },
    );
    expect(store.snapshot().refinements[0]).toMatchObject({
      id: "refine_9",
      trigger: "Remember",
      changes: ["create memory:lesson"],
    });
  });
});

describe("rollback and history", () => {
  it("builds a rollback from applied before/after snapshots", () => {
    const store = new FakeMemory();
    seed(store, "memory", "keep");
    const result = applyRefinementProposal(
      store,
      proposal([
        { action: "update", kind: "memory", id: "keep", title: "New", content: "new" },
        { action: "create", kind: "memory", id: "new", title: "New", content: "new" },
      ]),
      { id: "r1" },
    );
    expect(buildRollbackProposal(result).edits).toMatchObject([
      { action: "delete", kind: "memory", id: "new" },
      { action: "update", kind: "memory", id: "keep", content: "memory content" },
    ]);
  });

  it("infers scope from legacy result snapshots", () => {
    const store = new FakeMemory("global");
    const before = seed(store);
    const result: RefinementResult = {
      id: "old",
      summary: "Old",
      rationale: "",
      expectedOutcome: "",
      appliedEdits: [{ action: "delete", kind: "memory", id: "lesson", before, applied: true }],
    };
    expect(inferRefinementResultScope(result)).toBe("global");
  });

  it("extracts only typed refinement custom entries", () => {
    const result: RefinementResult = {
      id: "r1",
      summary: "x",
      rationale: "",
      expectedOutcome: "",
      appliedEdits: [],
    };
    expect(
      getRefinementHistory([
        { customType: "other", data: result },
        { customType: REFINEMENT_CUSTOM_TYPE, data: { nope: true } },
        { customType: REFINEMENT_CUSTOM_TYPE, data: result },
      ]),
    ).toEqual([result]);
  });
});

describe("prompt construction", () => {
  it("includes continual state, history, scope, trajectory tail, and custom instructions", () => {
    const store = new FakeMemory("global");
    seed(store);
    const prompt = buildRefinementUserPrompt({
      trajectory: `${"PREFIX".repeat(2_000)}${"x".repeat(80_000)}TAIL`,
      state: store.snapshot(),
      history: [],
      scope: "global",
      instructions: "focus on validation",
    });
    expect(prompt).toContain("[global:lesson]");
    expect(prompt).toContain("Requested refinement scope: global");
    expect(prompt).toContain("TAIL");
    expect(prompt).toContain("focus on validation");
    expect(prompt).not.toContain("PREFIXPREFIXPREFIX");
  });

  it("builds automatic review prompts without performing scheduling", () => {
    const prompt = buildAutoRefineReviewUserPrompt({
      trajectory: "tool failed twice",
      state: emptyState(),
      history: [],
      context: { reason: "compact", turnsSinceLastReview: 7 },
    });
    expect(prompt).toContain("compact; 7 assistant turns");
    expect(prompt).toContain("tool failed twice");

    const highSignalPrompt = buildAutoRefineReviewUserPrompt({
      trajectory: "remember this preference",
      state: emptyState(),
      history: [],
      context: { reason: "high_signal", turnsSinceLastReview: 1 },
    });
    expect(highSignalPrompt).toContain("high_signal; 1 assistant turns");
  });
});

describe("model-backed refinement", () => {
  it("plans JSON edits through the injected model port with a bounded output budget", async () => {
    let seenMax = 0;
    let seenSystem = "";
    installModelAccess({
      async completeSimple(_model, context, options) {
        seenMax = options.maxTokens;
        seenSystem = context.systemPrompt;
        return completion('{"summary":"A","rationale":"B","expectedOutcome":"C","edits":[]}');
      },
    });
    const plan = await planRefinement("trajectory", emptyState(), [], model(99_000), { scope: "local" });
    expect(plan.proposal.summary).toBe("A");
    expect(seenMax).toBe(32_000);
    expect(seenSystem).toContain("continual refinement subsystem");
  });

  it("builds rollback plans without calling the model", async () => {
    installModelAccess({
      async completeSimple() {
        throw new Error("should not run");
      },
    });
    const target: RefinementResult = {
      id: "target",
      summary: "Created",
      rationale: "",
      expectedOutcome: "",
      scope: "global",
      appliedEdits: [],
    };
    const plan = await planRefinement("", emptyState(), [target], model(), { rollbackId: "target" });
    expect(plan.rollbackOf).toBe("target");
    expect(plan.rollbackScope).toBe("global");
  });

  it("rejects unknown rollback ids", async () => {
    await expect(planRefinement("", emptyState(), [], model(), { rollbackId: "missing" })).rejects.toThrow(
      "Refinement missing not found",
    );
  });

  it("reports provider failures and output truncation", async () => {
    installModelAccess({ async completeSimple() { return completion("", "error"); } });
    await expect(planRefinement("x", emptyState(), [], model())).rejects.toThrow("provider failed");
    installModelAccess({ async completeSimple() { return completion("{", "length"); } });
    await expect(planRefinement("x", emptyState(), [], model())).rejects.toThrow(TRUNCATED_JSON_ERROR);
  });

  it("reviews automatic refinement with the smaller output budget", async () => {
    let seenMax = 0;
    installModelAccess({
      async completeSimple(_model, _context, options) {
        seenMax = options.maxTokens;
        return completion('{"shouldRefine":true,"rationale":"repeated failure","instructions":"record it"}');
      },
    });
    const review = await reviewAutoRefine(
      "trajectory",
      emptyState(),
      [],
      model(100_000),
      { reason: "turn_interval", turnsSinceLastReview: 10 },
    );
    expect(review).toEqual({ shouldRefine: true, rationale: "repeated failure", instructions: "record it" });
    expect(seenMax).toBe(4_096);
  });

  it("plans then applies against a baseline through refine()", async () => {
    const store = new FakeMemory();
    installModelAccess({
      async completeSimple() {
        return completion(
          '{"summary":"Remember","rationale":"Repeated","expectedOutcome":"Reuse","edits":[{"action":"create","kind":"memory","id":"lesson","title":"Lesson","content":"Keep it"}]}',
        );
      },
    });
    const result = await refine(store, "trajectory", store.snapshot(), [], model(), { scope: "local" });
    expect(result.appliedEdits[0]?.applied).toBe(true);
    expect(store.get("memory", "lesson")?.content).toBe("Keep it");
  });

  it("uses the target store scope when refine options omit scope", async () => {
    const store = new FakeMemory("global");
    let userPrompt = "";
    installModelAccess({
      async completeSimple(_model, context) {
        userPrompt = context.messages[0]?.content[0]?.text ?? "";
        return completion('{"summary":"No-op","rationale":"","expectedOutcome":"","edits":[]}');
      },
    });
    const result = await refine(store, "trajectory", store.snapshot(), [], model());
    expect(userPrompt).toContain("Requested refinement scope: global");
    expect(result.scope).toBe("global");
  });

  it("refuses to apply a rollback through the wrong scoped store", async () => {
    const localStore = new FakeMemory("local");
    const target: RefinementResult = {
      id: "global_change",
      summary: "Global change",
      rationale: "",
      expectedOutcome: "",
      scope: "global",
      appliedEdits: [],
    };
    await expect(
      refine(localStore, "", localStore.snapshot(), [target], model(), { rollbackId: "global_change" }),
    ).rejects.toThrow("requires a global memory store");
  });
});

describe("memory access", () => {
  it("opens stores only through the injected memory port", () => {
    const store = new FakeMemory("global");
    installMemoryAccess({ open: (stateDir, scope) => {
      expect(stateDir).toBe("/tmp/state");
      expect(scope).toBe("global");
      return store;
    } });
    expect(openMemory("/tmp/state", "global")).toBe(store);
  });
});
