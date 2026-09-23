# FRIDAY Client Interactions and Channel Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `channels.trusted` with a first-party client interaction boundary for Desktop/Android, migrate approvals/prompts/credential capture/cancellation/job delivery/alerts to that boundary, then remove the external Channels plugin and channel onboarding cleanly.

**Architecture:** Keep the existing `plugins/clients` plugin as the first-party product boundary rather than adding another plugin. Add a focused `clients.interactions` capability inside that plugin: process-local pending interaction continuations plus durable, non-secret interaction milestones in Events. Desktop/Android resolve pending requests through authenticated Client Gateway endpoints. Session Jobs and alerts deliver durable client notifications through Events rather than direct transport sends. Only after all production imports of `channels.trusted` are removed do we delete `plugins/channels`, channel onboarding/configuration, channel-specific tests/scripts, and generated workspace/registry references.

**Tech Stack:** TypeScript, Node 22, FRIDAY plugin capabilities, Events SQLite ledger, Client Gateway HTTP/WebSocket, Vault/Auth protected credential flow, Session Jobs, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-activity-stream-desktop-first-design.md`

## Global Constraints

- Execute only after the Activity Stream plan is merged and `main` is green.
- Do not delete `plugins/channels` until `rg` proves no production code imports `CHANNELS_TRUSTED_CAPABILITY` or `../channels/trusted-contract.js` outside the plugin itself.
- Do not rename the generic `InboundTurn.principal.channel`/authority identity shape in this plan; identity terminology migration is a separate security-sensitive change.
- First-party interactions must be authenticated through the existing paired-device Client Gateway authorization boundary.
- Secrets submitted for credential capture must never be written to Events, logs, conversation history, or activity summaries.
- Pending interaction metadata may be durable; secret values and promise continuations are process-local only.
- A FRIDAY restart may invalidate an in-flight prompt/approval/credential continuation; durable Session Job resume logic must re-enter/reissue the interaction rather than assuming the old callback survived.
- Alerts and background-job results become authoritative Events/client state, not best-effort direct messaging.

---

## File Structure

**Create**
- `plugins/clients/interactions-contract.ts` — transport-neutral first-party interaction capability/types.
- `plugins/clients/interactions.ts` — pending interaction broker, TTL/cancellation, durable public events, secret-safe resolution.

**Modify**
- `plugins/clients/index.ts` — provide `clients.interactions` capability.
- `plugins/clients/transport.ts` — authenticated list/resolve/cancel/credential endpoints.
- `plugins/clients/contract.ts` — expose interaction service/resource types where required.
- `plugins/permissions/index.ts`
- `plugins/auth/index.ts`
- `plugins/runtime-settings/index.ts`
- `plugins/mcp/index.ts`
- `plugins/self-improvement/index.ts`
- `plugins/conditional-hooks/index.ts`
- `plugins/session-jobs/index.ts`
- `plugins/alerts/index.ts`
- `plugins/artifacts/index.ts`
- `friday.config.json`
- `package.json`
- `package-lock.json`
- `src/onboarding.ts`
- `src/setup-cli.ts`
- `src/doctor.ts`
- `README.md`
- `SECURITY.md`
- `SUPPORT.md`
- `docs/DOCTOR.md`
- `docs/REMOTE_ONBOARDING.md`
- `docs/ROADMAP.md`
- generated builtin-plugin registry files as produced by `npm run generate:builtin-plugins`.

**Delete only after migration gate passes**
- `plugins/channels/**`
- `src/onboarding-channels.ts`
- `test/channels.test.ts`
- `test/channel-config.test.ts`
- `test/channel-permission-approval.test.ts` (replace with client interaction approval coverage before deletion)
- channel-specific security test imports that exist only for transport code, including the Discord heartbeat unit currently imported by `test/codeql-security-hardening.test.ts`.

**Migrate tests**
- `test/permissions.test.ts`
- `test/runtime-settings.test.ts`
- `test/session-job-delivery.test.ts`
- `test/session-jobs-actions.test.ts`
- `test/self-improvement-feasibility.test.ts`
- `test/artifacts.test.ts`
- `test/alerts.test.ts`
- `test/plugin-boundaries.test.ts`
- `test/client-gateway.test.ts`
- `test/doctor.test.ts`
- `test/onboarding.test.ts`

---

### Task 1: Add the first-party `clients.interactions` capability

**Files:**
- Create: `plugins/clients/interactions-contract.ts`
- Create: `plugins/clients/interactions.ts`
- Modify: `plugins/clients/index.ts`
- Test: `test/client-gateway.test.ts`

**Interfaces:**

Use the existing principal shape without renaming it in this plan:

```ts
export interface ClientInteractionPrincipal {
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string;
}
```

Define:

```ts
export type ClientInteractionKind = "notification" | "approval" | "prompt" | "credential" | "cancellation";

export interface PendingClientInteraction {
  readonly id: string;
  readonly code: string;
  readonly kind: ClientInteractionKind;
  readonly principal: ClientInteractionPrincipal;
  readonly title: string;
  readonly message: string;
  readonly options: readonly Readonly<{ label: string; value: string; description?: string }>[];
  readonly allowCustom: boolean;
  readonly secret: boolean;
  readonly jobId?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ClientInteractionsService {
  notify(input: Readonly<{ principal: ClientInteractionPrincipal; title: string; message: string; jobId?: string }>): Promise<void>;
  requestApproval(input: Readonly<{ principal: ClientInteractionPrincipal; actionId: string; effect: string; resource: string; reason: string; network?: boolean; jobId?: string; ttlMs?: number }>): Promise<boolean>;
  requestPrompt(input: Readonly<{ principal: ClientInteractionPrincipal; title?: string; message: string; notes?: string; options?: readonly Readonly<{ label: string; value: string; description?: string }>[]; allowCustom?: boolean; jobId?: string; placeholder?: string; allowEmpty?: boolean; maxLength?: number; ttlMs?: number }>): Promise<string>;
  requestCredential(input: Readonly<{ principal: ClientInteractionPrincipal; title: string; message: string; ttlMs?: number; validate: (secret: Uint8Array) => void | Promise<void>; store: (secret: Uint8Array) => void | Promise<void> }>): Promise<void>;
  watchCancellation(input: Readonly<{ principal: ClientInteractionPrincipal; label: string; ttlMs?: number }>): Promise<Readonly<{ request: PendingClientInteraction; signal: AbortSignal; dispose(): void }>>;
  pending(): readonly PendingClientInteraction[];
  resolve(input: Readonly<{ requestId: string; value?: string; approved?: boolean; cancel?: boolean }>): Promise<void>;
}

export const CLIENT_INTERACTIONS_CAPABILITY = defineCapability<ClientInteractionsService>("clients.interactions");
```

- [ ] **Step 1: Write failing broker tests**

Add tests proving:
- approval resolves only from exact request ID and matching first-party principal/device authority;
- prompt selection/custom text is bounded;
- cancellation aborts the exposed signal once;
- TTL expiration rejects the pending promise;
- notifications publish a durable `client-interaction.notification` Event;
- approval/prompt request metadata publishes durable `client-interaction.requested` and terminal `client-interaction.resolved`/`expired` Events;
- credential secret bytes never appear in any published Event and are zeroed after validation/store callbacks settle.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/client-gateway.test.ts -t "client interaction"
```

Expected: FAIL because `clients.interactions` does not exist.

- [ ] **Step 3: Implement the broker**

Use process-local Maps keyed by request ID for promise continuations and `AbortController`s. Use Events only for public metadata. Generate short human-readable approval codes only for UI display; request ID remains authoritative.

For credential resolution:

```ts
const bytes = Buffer.from(value, "utf8");
try {
  await request.validate(bytes);
  await request.store(bytes);
} finally {
  bytes.fill(0);
}
```

Never put `value` or any derived secret text into an Event or operational error payload.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run test/client-gateway.test.ts -t "client interaction"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/clients/interactions-contract.ts plugins/clients/interactions.ts plugins/clients/index.ts test/client-gateway.test.ts
git commit -m "feat(clients): add first-party interaction broker"
```

---

### Task 2: Expose authenticated interaction APIs to Desktop/Android

**Files:**
- Modify: `plugins/clients/transport.ts`
- Modify: `plugins/clients/contract.ts`
- Test: `test/client-gateway.test.ts`

**Interfaces:**

Add authenticated routes:

```text
POST /v1/interactions/list
POST /v1/interactions/resolve
POST /v1/interactions/cancel
POST /v1/interactions/credential
```

`list` returns public pending metadata only. `resolve` handles approval/prompt/cancellation. `credential` accepts `{ requestId, value }` and forwards the value directly to the in-memory credential resolver without publishing/logging it.

- [ ] **Step 1: Write failing gateway authorization/security tests**

Prove:
- read-only paired devices may list pending interactions but cannot resolve them;
- operator devices can resolve only current pending requests;
- credential endpoint is `system-write` authorized;
- wrong/expired request IDs fail closed;
- response bodies never echo credential values;
- operation-bound signatures cover each route body under the existing client signing protocol.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/client-gateway.test.ts
```

Expected: FAIL because the routes/resources do not exist.

- [ ] **Step 3: Implement routes using the existing authenticated-device helper**

Do not add a second auth mechanism. Reuse the current client permission action classification and keep credential request bodies out of observability fields.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run test/client-gateway.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/clients/transport.ts plugins/clients/contract.ts test/client-gateway.test.ts
git commit -m "feat(clients): expose protected interaction APIs"
```

---

### Task 3: Migrate Permissions and protected prompts from `channels.trusted`

**Files:**
- Modify: `plugins/permissions/index.ts`
- Modify: `plugins/runtime-settings/index.ts`
- Modify: `plugins/conditional-hooks/index.ts`
- Modify: `plugins/mcp/index.ts`
- Modify: `plugins/self-improvement/index.ts`
- Test: `test/permissions.test.ts`
- Test: `test/runtime-settings.test.ts`
- Test: `test/conditional-hooks.test.ts`
- Test: `test/mcp.test.ts`
- Test: `test/self-improvement-feasibility.test.ts`

**Interfaces:**
- Replace `CHANNELS_TRUSTED_CAPABILITY` imports with `CLIENT_INTERACTIONS_CAPABILITY`.
- Preserve current principal identity values; only the interaction transport changes.

- [ ] **Step 1: Convert tests to provide `clients.interactions` fakes**

For approval tests, fake only `requestApproval`. For prompt tests, fake only `requestPrompt`. For self-improvement cancellation, fake `watchCancellation`. Keep tests asserting exact principal/resource/action attribution.

- [ ] **Step 2: Run converted tests and verify RED**

```bash
npx vitest run test/permissions.test.ts test/runtime-settings.test.ts test/conditional-hooks.test.ts test/mcp.test.ts test/self-improvement-feasibility.test.ts
```

Expected: FAIL until production manifests/imports are migrated.

- [ ] **Step 3: Migrate production imports/manifests/calls**

Use the same request semantics; do not change permission policy. Replace direct channel sends that only announce a prompt with `interactions.notify()`.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run test/permissions.test.ts test/runtime-settings.test.ts test/conditional-hooks.test.ts test/mcp.test.ts test/self-improvement-feasibility.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/permissions/index.ts plugins/runtime-settings/index.ts plugins/conditional-hooks/index.ts plugins/mcp/index.ts plugins/self-improvement/index.ts test/permissions.test.ts test/runtime-settings.test.ts test/conditional-hooks.test.ts test/mcp.test.ts test/self-improvement-feasibility.test.ts
git commit -m "refactor(interactions): move protected prompts to clients"
```

---

### Task 4: Migrate Auth credential capture without routing secrets through chat

**Files:**
- Modify: `plugins/auth/index.ts`
- Test: `test/auth.test.ts`
- Test: `test/auth-oauth-model-discovery.test.ts`
- Test: `test/runtime-settings.test.ts`
- Test: `test/client-gateway.test.ts`

**Interfaces:**
- Auth owns validation and Vault writes.
- `clients.interactions` owns only request lifecycle and receives secret bytes transiently from the authenticated client endpoint.

- [ ] **Step 1: Write failing credential-flow tests**

Prove:
- API key capture creates a `credential` interaction rather than intercepting the next chat message;
- submitted secret is validated before Vault mutation;
- invalid secret remains unstored and produces a public failure state without echoing secret text;
- OAuth prompt steps use `requestPrompt`/`notify` rather than channel send;
- no secret appears in Events replay, Turn transcript, or test-captured activity.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/auth.test.ts test/auth-oauth-model-discovery.test.ts test/client-gateway.test.ts
```

Expected: FAIL until Auth uses client interactions.

- [ ] **Step 3: Implement Auth migration**

Replace `requestCredentialCapture`/`waitForCredentialCapture` with one `requestCredential` promise whose `validate` callback runs provider validation and whose `store` callback rotates/creates the intended Vault ref. Keep the existing secret byte wiping in both Auth and interaction broker boundaries.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run test/auth.test.ts test/auth-oauth-model-discovery.test.ts test/client-gateway.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/auth/index.ts test/auth.test.ts test/auth-oauth-model-discovery.test.ts test/client-gateway.test.ts
git commit -m "refactor(auth): move credential capture to clients"
```

---

### Task 5: Move Session Job delivery and alerts to durable client notifications

**Files:**
- Modify: `plugins/session-jobs/index.ts`
- Modify: `plugins/alerts/index.ts`
- Test: `test/session-job-delivery.test.ts`
- Test: `test/session-jobs-actions.test.ts`
- Test: `test/alerts.test.ts`

**Interfaces:**
- Background completion/update delivery uses `ClientInteractionsService.notify()`.
- Notifications are durable Events and therefore do not require a currently connected Desktop/Android socket.

- [ ] **Step 1: Write failing delivery tests**

Prove:
- job result notification succeeds even with zero connected clients because the durable Event is the delivery commit point;
- reconnecting client can replay the notification event;
- job resume after process restart re-enters Turn Loop and may issue a fresh interaction instead of needing the old channel transport;
- alerts publish client notifications and retain existing permission checks.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/session-job-delivery.test.ts test/session-jobs-actions.test.ts test/alerts.test.ts
```

Expected: FAIL because these plugins still require Channels.

- [ ] **Step 3: Migrate production code**

Replace `channels.send(...)` with `interactions.notify(...)`. Replace Session Job prompt/approval helpers with `requestPrompt`/`requestApproval`. Remove the requirement that `job.origin.authority === "channel"` merely to deliver a result; first-party `channel: "client"` origins remain valid under the existing principal structure.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run test/session-job-delivery.test.ts test/session-jobs-actions.test.ts test/alerts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/session-jobs/index.ts plugins/alerts/index.ts test/session-job-delivery.test.ts test/session-jobs-actions.test.ts test/alerts.test.ts
git commit -m "refactor(clients): deliver jobs and alerts through events"
```

---

### Task 6: Remove the remaining non-interaction Channels dependencies

**Files:**
- Modify: `plugins/artifacts/index.ts`
- Modify affected tests: `test/artifacts.test.ts`, `test/plugin-boundaries.test.ts`

**Interfaces:**
- Client-uploaded artifacts remain first-party API resources.
- External channel attachment fetching is removed with Channels; no replacement transport fetch API is introduced in this task.

- [ ] **Step 1: Write/adjust failing artifact boundary tests**

Assert that Artifacts no longer advertises `channels.trusted` as optional and that external transport attachment fetch is unavailable after channel removal. Preserve normal private artifact storage/inspect/download behavior.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/artifacts.test.ts test/plugin-boundaries.test.ts
```

Expected: FAIL while Artifacts still imports Channels.

- [ ] **Step 3: Remove the channel attachment adapter path**

Delete only the code path that calls `channels.fetchAttachment`. Do not change artifact integrity, quotas, archive extraction, or client artifact metadata APIs.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run test/artifacts.test.ts test/plugin-boundaries.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/artifacts/index.ts test/artifacts.test.ts test/plugin-boundaries.test.ts
git commit -m "refactor(artifacts): drop external channel attachments"
```

---

### Task 7: Prove the production tree no longer depends on Channels

**Files:**
- No production changes in this task unless the scan finds a missed dependency.

- [ ] **Step 1: Run the hard migration gate**

```bash
rg -n \
'CHANNELS_(TRUSTED_)?CAPABILITY|channels\.trusted|\.\./channels/(trusted-)?contract' \
plugins src \
--glob '!plugins/channels/**'
```

Expected: **no output**.

- [ ] **Step 2: Scan first-party production code for direct channel package imports**

```bash
rg -n '@friday/channels|plugins/channels|onboarding-channels' plugins src apps packages friday.config.json package.json \
--glob '!plugins/channels/**'
```

Expected: only the still-to-be-deleted registry/config/onboarding references, not runtime dependencies.

- [ ] **Step 3: If either scan finds a runtime dependency, stop**

Do not delete Channels. Add the missing migration to the relevant prior task, test it, commit it, and rerun both scans until they satisfy the expected result.

---

### Task 8: Delete external Channels and channel onboarding/configuration

**Files:**
- Delete: `plugins/channels/**`
- Delete: `src/onboarding-channels.ts`
- Delete: `test/channels.test.ts`
- Delete: `test/channel-config.test.ts`
- Delete/replace: `test/channel-permission-approval.test.ts`
- Modify: `friday.config.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/onboarding.ts`
- Modify: `src/setup-cli.ts`
- Modify: `src/doctor.ts`
- Modify: channel-specific tests/docs listed in File Structure.

- [ ] **Step 1: Remove the plugin and dedicated tests with Git-aware deletion**

```bash
git rm -r plugins/channels
git rm src/onboarding-channels.ts test/channels.test.ts test/channel-config.test.ts
```

If `test/channel-permission-approval.test.ts` has been replaced by client interaction approval coverage, remove it too:

```bash
git rm test/channel-permission-approval.test.ts
```

- [ ] **Step 2: Remove plugin registration and obsolete scripts**

Delete `./plugins/channels/index.ts` from `friday.config.json`.

Remove these package scripts:

```json
"presetup:whatsapp": "npm run build:workspaces",
"setup:whatsapp": "tsx src/friday.ts setup whatsapp"
```

Remove channel setup commands/menu entries from `src/onboarding.ts` and `src/setup-cli.ts`.

- [ ] **Step 3: Remove channel-specific Doctor checks**

Delete checks whose purpose is external transport configuration/access/tooling (`channels`, `channel-access`, WhatsApp tooling). Preserve client gateway/device/security/Computer checks.

Update `test/doctor.test.ts` so health expectations are first-party client oriented.

- [ ] **Step 4: Regenerate workspace and builtin metadata**

```bash
npm install --package-lock-only
npm run generate:builtin-plugins
```

Do not hand-edit generated builtin registry output if the generator changes it.

- [ ] **Step 5: Remove transport-only security test imports**

`test/codeql-security-hardening.test.ts` currently imports the Channels Discord heartbeat helper. Remove that transport-only test when the provider source is deleted; preserve all unrelated CodeQL hardening tests.

- [ ] **Step 6: Run architecture/packaging tests**

```bash
npm run check:architecture
npm run check:packaging
npx vitest run test/plugin-boundaries.test.ts test/bootstrap.test.ts test/doctor.test.ts test/onboarding.test.ts test/codeql-security-hardening.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove external messaging channels"
```

---

### Task 9: Update product documentation to Desktop/Android-only ingress

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `SUPPORT.md`
- Modify: `docs/DOCTOR.md`
- Modify: `docs/REMOTE_ONBOARDING.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Update current product docs**

State that supported conversational product ingress is the authenticated Client Gateway consumed by Desktop and, after Phase 7, Android. Remove setup instructions for Telegram/WhatsApp/Discord/Slack/Teams/Google Chat/Signal/Email.

Keep historical roadmap/ADR references only when they are explicitly historical; do not rewrite old release history to pretend Channels never existed.

- [ ] **Step 2: Update Roadmap current-state language**

Mark external Channels removed after first-party interaction migration and retain Phase 6 acceptance language that Desktop replaces normal messaging-channel use. Keep the implementation order from the approved Activity Stream spec.

- [ ] **Step 3: Run documentation/reference scan**

```bash
rg -n -i \
'plugins/channels|channels\.trusted|setup:whatsapp|setup whatsapp|telegram|whatsapp|discord|slack|microsoft teams|google chat|signal' \
README.md SECURITY.md SUPPORT.md docs src package.json friday.config.json plugins test \
--glob '!docs/architecture/adr/**' \
--glob '!CHANGELOG.md' \
--glob '!docs/superpowers/specs/**' \
--glob '!docs/superpowers/plans/**'
```

Expected: no active setup/runtime references. Any remaining occurrences must be clearly historical or generic identity terminology intentionally deferred by the spec.

- [ ] **Step 4: Commit**

```bash
git add README.md SECURITY.md SUPPORT.md docs/DOCTOR.md docs/REMOTE_ONBOARDING.md docs/ROADMAP.md
git commit -m "docs: make desktop and mobile the product ingress"
```

---

### Task 10: Full verification and protected-main PR handoff

**Files:**
- No source changes unless verification finds a concrete regression.

- [ ] **Step 1: Run hard no-Channels scans again**

```bash
rg -n 'CHANNELS_(TRUSTED_)?CAPABILITY|channels\.trusted|@friday/channels|plugins/channels' plugins src apps packages friday.config.json package.json test
```

Expected: no live code/package references; only intentionally retained historical text outside these paths if any.

- [ ] **Step 2: Run full verification**

```bash
npm run verify:report
grep -E 'PASS:|FAIL:|FINAL SUMMARY|Passed stages|Failed stages' report.log
```

Expected:

```text
Passed stages: 9
Failed stages: 0
```

- [ ] **Step 3: Confirm the branch diff is scoped**

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: client-interaction migration, channel deletion, related tests/docs only.

- [ ] **Step 4: Push to a PR branch**

```bash
git push -u origin refactor/client-interactions-remove-channels
```

- [ ] **Step 5: Create the protected-main PR**

```bash
gh pr create \
  --base main \
  --head refactor/client-interactions-remove-channels \
  --title "refactor: replace channels with first-party client interactions" \
  --body "Moves approvals, prompts, credentials, cancellation, job delivery, and alerts onto the authenticated Desktop/Android client boundary, then removes external messaging Channels. Full verify: 9/9 required before merge."
```

- [ ] **Step 6: Merge only after required checks pass**

```bash
gh pr checks --watch
gh pr merge --merge --delete-branch
```
