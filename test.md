# F.R.I.D.A.Y Human Test Guide

This is the shareable manual test plan for a junior tester. It is written from the current repository behavior.

Coverage was rechecked against the current source: 104 system actions, 23 Agent tools, 39 HTTP routes, and the `channels.reminder` scheduled action are represented below. Re-run `system.actions` after adding a plugin or action so the manual stays synchronized.

## Important: what counts as a “button” here

The repository currently provides a CLI, runtime action registry, Agent tools, HTTP APIs, WebSocket streaming, and Linux Computer scripts. A finished desktop or Android UI is planned but is not present in this repository yet.

When this guide says **click a button**, use the matching action ID in the operator/client surface, or call the documented HTTP endpoint. The action ID is the source of truth for what a future UI button must invoke.

## Test rules

- Use a disposable test machine or a temporary `FRIDAY_HOME` whenever possible.
- Never use a real password, OTP, API key, CAPTCHA answer, private repository, or production account.
- Stop FRIDAY before backup, restore, or vault recovery tests.
- Record the exact command, timestamp, environment, result, and a screenshot/log for every failure.
- A test passes only when both the operation and the expected safety behavior pass.
- “Expected error” means the command must reject safely; an error in that test is a pass.

## 1. Prepare the test environment

From the repository root:

```bash
node --version                 # Node 22 or newer
npm ci
cp .env.example .env.local 2>/dev/null || true
mkdir -p /tmp/friday-test-home
export FRIDAY_HOME=/tmp/friday-test-home
```

Expected:

- Node reports version 22 or newer.
- `npm ci` exits with code 0.
- No command prints secrets.

For normal automated checks, run:

```bash
npm run typecheck
npm run check:architecture
npm run check:silent-failures
```

Expected: all three commands finish successfully.

The complete `npm run verify` suite also starts local sockets and subprocesses. If the execution environment blocks those operations with `EPERM`, record that as an environment limitation and run the focused tests below on a normal host.

## 2. CLI smoke tests

Run each command exactly as shown. Capture stdout, stderr, and exit code.

| Test | Action/button | Steps | Expected result |
|---|---|---|---|
| CLI-01 | Help | `npm run friday -- --help` | Usage lists run, setup, backup, doctor, vault recovery, version, and maintenance commands. Exit 0. |
| CLI-02 | Version | `npm run friday -- --version` | Prints one version string matching `package.json`. Exit 0. |
| CLI-03 | Run alias | `timeout 5 npm run friday -- run` | Starts runtime or reports a clear missing-configuration error; it must not crash with an unhandled stack trace. |
| CLI-04 | Unknown command | `npm run friday -- definitely-not-a-command` | Exit non-zero and prints `Unknown FRIDAY command`. |
| CLI-05 | Doctor text | `npm run friday -- doctor` | Prints `F.R.I.D.A.Y Doctor`, platform/Node/home, section headings, summary counts, and one-line repair guidance where applicable. |
| CLI-06 | Doctor JSON | `npm run friday -- doctor --json` | Prints valid JSON only. It contains checks/levels and does not contain plaintext credentials. |
| CLI-07 | Doctor fix safety | Run `npm run friday -- doctor --fix` in a non-TTY pipe. | Refuses with a clear interactive-terminal message; it does not silently change state. |
| CLI-08 | Setup help | `npm run friday -- setup --help` | Lists provider/model/routing/permission/timezone/sandbox/channel options. Exit 0. |
| CLI-09 | Setup invalid option | `npm run friday -- setup --not-an-option` | Exit non-zero and identifies the unknown option. |
| CLI-10 | Setup validation | `npm run friday -- setup --permission invalid` | Exit non-zero and explains the accepted permission modes. |
| CLI-10a | Deprecated onboard alias | `npm run friday -- onboard --help` | Runs setup compatibility mode and prints a deprecation warning telling the user to use `friday setup`; no separate onboarding state is created. |
| CLI-10b | Scriptable setup flags | In a disposable home, run `npm run friday -- setup --provider <id> --model <id> --routing-provider <id> --routing-model <id> --permission ask --timezone UTC --skip-sandbox --skip-channels`. | Each supplied value is validated and persisted through the normal setup flow; credentials remain in Vault. Conflicting pairs (`--routing-main` + `--routing-separate`, `--channels` + `--skip-channels`, or `--setup-sandbox` + `--skip-sandbox`) are rejected. |
| CLI-11 | Backup help/error | `npm run friday -- backup` | Exit non-zero with backup usage. |
| CLI-12 | Backup list | `npm run friday -- backup list --directory /tmp/friday-backups` | Prints a JSON array. An empty directory returns `[]` rather than creating unrelated files. |
| CLI-13 | Backup create | Stop FRIDAY, then `npm run friday -- backup create --directory /tmp/friday-backups` | Prints a JSON manifest with an ID, timestamps, and file information. |
| CLI-14 | Backup verify | `npm run friday -- backup verify <id> --directory /tmp/friday-backups` | Prints the manifest and verifies checksums. |
| CLI-15 | Backup restore guard | `npm run friday -- backup restore <id> --directory /tmp/friday-backups` without `--yes` | Refuses; no state is overwritten. |
| CLI-16 | Backup restore | Stop FRIDAY, then `npm run friday -- backup restore <id> --yes --directory /tmp/friday-backups` | Prints JSON success and restores only the backup state. |
| CLI-17 | Encrypted backup | Set `FRIDAY_BACKUP_PASSPHRASE` to a temporary 12+ character value; create with `--encrypt`; verify with the same value. | Backup succeeds; passphrase is never printed or accepted as a CLI argument. Wrong passphrase fails. |
| CLI-18 | Vault recovery create | Set `FRIDAY_VAULT_RECOVERY_PASSPHRASE` to a temporary 12+ character value; run `npm run friday -- vault recovery create --out /tmp/friday-recovery.kit`. | Creates a file with restrictive permissions and prints the resolved output path. |
| CLI-19 | Vault recovery restore | Stop FRIDAY; run `npm run friday -- vault recovery restore --in /tmp/friday-recovery.kit`. | Prints `Vault recovery key verified and installed.`; wrong passphrase fails without replacing the vault. |

## 3. Automated regression tests

Run the focused test set first:

```bash
FRIDAY_HOME=/tmp/friday-focused-home npx vitest run --config vitest.config.ts \
  test/computer.test.ts \
  test/computer-linux-sway.test.ts \
  test/linux-computer-deployment.test.ts \
  test/plugin-boundaries.test.ts \
  test/doctor.test.ts \
  test/packaging-discovery.test.ts \
  packages/client-protocol/test/protocol.test.ts
```

Expected: all tests pass.

Then run the full suite on a host that permits local sockets and child processes:

```bash
npm run verify
```

Expected: architecture, packaging, typecheck, silent-failure, model catalog, Vitest, and workspace tests all pass.

### First-run setup prompt buttons

Run `npm run friday -- setup` in a disposable `FRIDAY_HOME`. Exercise both setup styles and record every prompt choice.

| Prompt/choice | How to test | Expected result |
|---|---|---|
| Quick setup | Select **Quick setup**, complete the required routing model, trusted operator channel, and host-privilege decision. | Mandatory local bootstrap completes, optional steps remain pending, and the terminal tells the tester to continue from the paired trusted channel. |
| Custom setup | Select **Custom setup**, accept and decline each optional section once. | Mandatory bootstrap still runs first; accepted sections execute, declined sections are marked `skipped`, and the final state is resumable. |
| Host privilege: broker | Select **Allow approved FRIDAY operations** on a disposable host and complete sudo authentication locally. | Only the restricted broker is installed/configured; no arbitrary sudo shell is exposed and no password is captured by FRIDAY. |
| Host privilege: none | Select **Never allow privileged operations**. | Policy is saved as `none`; privileged requests return a manual-action/repair response and never invoke sudo. |
| Optional-step confirmation | For voice, sandbox, execution Python, and self-repository choose both Yes and No in separate runs. | Yes runs the owner setup and marks the step complete; No makes no external change and marks it skipped. |
| Setup cancellation/error | Abort a prompt or provide an invalid provider/path. | Setup exits with a bounded error, leaves prior valid state intact, and records a redacted setup diagnostic. |

### Ingress-channel editor buttons

| Button/choice | How to test | Expected result |
|---|---|---|
| Channel list | Open channel management and select each of Telegram, WhatsApp, Discord, Slack, Signal, Email, Microsoft Teams, Google Chat, and SMS/Twilio. | Each channel opens its own required settings; **Done** returns to setup only when first-run requirements are satisfied. |
| Enable/Edit | Choose **Enable channel** (or **Edit configuration**) and provide disposable account/access values. | Settings are validated and saved; credentials are captured in hidden/protected input and stored as Vault references. |
| Disable | Choose **Disable** for a configured channel. | Channel stops being active but its non-secret configuration and Vault references remain for later re-enable. |
| Remove configuration | Choose **Remove configuration**, then reopen the channel list. | Only that channel’s saved configuration is deleted; unrelated channels and trust identities remain unchanged. |
| Back | Choose **Back** from a channel editor. | Current channel state is unchanged and the channel list is shown again. |
| Initial operator pairing | Enable a channel with an exact allowed sender ID and confirm the pairing prompt; also try declining confirmation. | Confirming trusts exactly that sender as operator. Declining aborts safely and restores the previous channel configuration. Other allowed senders remain untrusted. |
| First-run Done guard | On a fresh home, choose **Done** with no enabled channel or with no exact paired operator. | Setup refuses to finish and explains the missing requirement; it does not publish operational defaults. |

### Repository and release scripts

Run build/release checks only in a disposable checkout; binary build/package commands intentionally replace `build/binary`.

| Command/script | How to test | Expected result |
|---|---|---|
| `npm test` | Run after `npm ci`. | Architecture, packaging, root Vitest, and workspace tests pass. |
| `npm run test:workspaces` | Run in a clean dependency tree. | Workspace packages build and their tests pass. |
| `npm run check:models` | Run without editing generated files. | Model catalog is current; stale generated metadata fails with a clear repair command. |
| `npm run inspect:plugins` / `inspect:plugins:json` | Run both variants. | Human and JSON plugin catalogs list capabilities/contributions deterministically. |
| `npm run check:workspace-node-modules` | Run after `npm ci`. | Reports dependency-tree hygiene as passing. |
| `npm run clean:workspace-node-modules` | Run only in a disposable checkout, then reinstall with `npm ci`. | Removes workspace-local dependency trees and leaves the repository recoverable by reinstall. |
| `npm run build:binary` | Run on a supported Linux/macOS x64/arm64 host with native dependencies installed. | Produces `build/binary/friday`, verifies the candidate with `--version`, and exits non-zero without a valid native addon. |
| `npm run package:binary` | Run after `build:binary`. | Produces `build/release/friday-<os>-<arch>` and a matching `.sha256` file. Unsupported Windows/architecture fails closed. |
| `scripts/smoke-release-binary.sh build/release/friday-<os>-<arch>` | Run against the packaged executable. | Binary reaches `FRIDAY ready.`, keeps workspace outside `FRIDAY_HOME`, shuts down on SIGTERM, and prints `FRIDAY packaged runtime smoke: PASS`. |
| `scripts/install-release.sh OWNER/REPO` | Use a disposable POSIX account with `gh` attestation support; also try malformed repository/unsupported architecture. | Downloads over TLS, verifies SHA-256 and GitHub attestation before replacement, runs a version preflight, and leaves the old binary intact on failure. |
| `scripts/install-release.ps1` | On Windows with WSL2, run with a disposable repository value; also test without WSL2. | Verifies the bootstrap installer inside WSL2 and delegates to the POSIX installer; without ready WSL2 it exits with a clear message. |

## 4. System status and dashboard buttons

These are read-only operator buttons. Run them after the runtime is configured.

| Button/action ID | What it does | How to test | Expected result |
|---|---|---|---|
| `system.status` | Shows every installed plugin’s bounded status snapshot. | Open operator actions and run it with `{}`. | JSON/object grouped by plugin ID; no secrets or unbounded logs. |
| `operator.dashboard` | Correlates jobs, approvals/questions, delivery failures, schedules, and usage. | Run with `{}`. | One object with `generatedAt` and bounded status sections. |
| `system.actions` | Lists installed action IDs, labels, and descriptions. | Run with `{}`. | Sorted action catalog; the catalog itself does not execute an action. |
| `diagnostics.doctor` | Runs runtime diagnostics. | Run with `{}`. | Checks and repair guidance; no hidden repair writes. |
| `diagnostics.review` | Reviews stored failure evidence. | Run with `{}`. | Bounded evidence records with sensitive values redacted. |
| `host.privilege.status` | Shows privilege policy/helper readiness. | Run with `{}`. | Reports policy and helper status; never exposes arbitrary shell execution. |
| `execution.python.setup` | Provisions FRIDAY’s private Python environment. | Approve and run once. | Reports Python path/ready state; rerunning is idempotent. |
| `sandbox.setup` | Prepares the configured sandbox provider. | Approve and run in a disposable environment. | Provider readiness is reported; failure includes a repair hint. |

### Runtime settings and onboarding buttons

| Button/action ID | How to test | Expected result |
|---|---|---|
| `onboarding.status` | Run with `{}` before and after `friday setup`. | Returns persistent phase/step state and `nextSteps`; no secrets. Before setup it tells the tester to run setup locally. |
| `onboarding.continue` | Run from a trusted channel with `{}`. | Returns whether local bootstrap is ready, pending optional steps, and the owning action IDs; it cannot remotely claim mandatory completion. |
| `onboarding.step` | Run `{ "step": "timezone", "status": "skipped" }`, then `{ "step": "timezone", "status": "pending" }`. | State changes exactly as requested. `status: "complete"` and mandatory steps are rejected. |
| `runtime.settings` | Run with `{}`. | Shows non-secret main/routing model, router-only state, permission mode, timezone, workspace, and self-repository. |
| `onboarding.main-model.setup` | From a trusted channel, provide a disposable registered provider/model; use `restart: false` for a manual test. | Validates provider/model, captures credentials only through protected Vault flow when needed, marks `mainModel` complete, and reports the selected model. Non-channel or unknown model requests fail safely. |
| `runtime.settings.update` | Change one safe field, e.g. `{ "permissionMode": "ask", "timezone": "UTC", "restart": false }`; then restore the original value. | Only supplied fields change; settings are returned without secrets. Invalid model/timezone/mode is rejected. With `restart: true`, active work requires approval and the verified handoff is reported. |
| `runtime.custom-model.configure` | From a trusted channel, use a disposable OpenAI-compatible loopback endpoint, model ID, `requireApiKey: false`, `useFor: "none"`, `restart: false`. | Endpoint/model are validated and listed; no credential is requested when disabled. Unsafe URL, invalid limits, or missing channel for API-key capture fails before persistence. |
| `runtime.custom-models` | Run with `{}` after custom-model setup. | Lists provider/model/name/base URL and optional limits, never API keys. |
| `runtime.custom-model.remove` | Remove an inactive disposable custom model by provider/model ID. | Returns `removed: true` and unregisters it. Removing the active main/routing model is rejected. |

### Personas (Agent tools)

| Tool | How to test | Expected result |
|---|---|---|
| `persona_list` | Ask the Agent to list personas or call with `{}`. | Returns active persona plus built-ins (`friday`, `jarvis`) and custom metadata, without instructions/secrets. |
| `persona_switch` | In the same user turn explicitly ask to switch to `jarvis`, then call `{ "name": "jarvis" }`. | Switch succeeds and applies on the next model turn. A tool call without an explicit current-user request is rejected. |
| `persona_create` | Explicitly ask to create a disposable persona, then provide `{ "name": "tester", "instructions": "Use short test notes.", "activate": true }`. | Persona is persisted, optionally activated, and listed. Policy-override instructions are rejected. |
| `persona_delete` | Explicitly ask to delete `tester`, then call `{ "name": "tester" }`. | Custom persona is removed and active persona falls back to `friday` if needed. Built-ins cannot be deleted. |

## 5. Agent Profiles and Conversations buttons/APIs

| Action/tool/API operation | Inputs | Expected result |
|---|---|---|
| `agent-profiles.list` | `{}` | Lists profile metadata only. |
| `agent-profiles.create` | Name plus optional role, memory scope, skills, plugins, project, screen, notifications, approval policy. | Creates a persistent profile with a stable ID and isolated memory scope. |
| `agent-profiles.update` | `profileId` plus fields to change. | Returns updated profile; omitted fields remain unchanged. |
| `agent-profiles.remove` | `profileId`. | Removes the profile and returns confirmation; unknown ID fails clearly. |
| `conversations.list` | `{}` | Lists direct/group conversation metadata. |
| `conversations.create` | `type` (`direct`/`group`), participants, optional title/session. | Creates a conversation linked to a durable session. |
| `conversations.channel-bindings` | `{}` | Lists external channel/chat/topic bindings without credentials. |
| `conversations.bind-channel` | Conversation/channel/chat/topic and routing mode. | Creates a binding and reports it. |
| `conversations.unbind-channel` | Binding ID. | Removes only that binding and restores normal routing. |
| `/v1/conversations/update` | Conversation ID and title/pinned/hidden/notifications fields. | Returns updated metadata. |
| `/v1/conversations/mark-read` | Conversation ID and sequence. | Read sequence advances; lower/invalid sequence is rejected. |
| `/v1/conversations/mentions/resolve` | Conversation ID and text containing mentions. | Returns resolved participant/profile mentions. |
| `/v1/conversations/threads/create` | Conversation ID and root message ID. | Creates a thread. |
| `/v1/conversations/threads/reply` | Thread ID. | Increments/reports thread reply state. |
| `/v1/conversations/reactions/add` | Message ID, actor ID, emoji. | Adds one reaction; duplicate behavior is deterministic. |
| `/v1/conversations/reactions/remove` | Message ID, actor ID, emoji. | Removes that reaction only. |
| `/v1/conversations/reactions/list` | Message ID. | Lists reactions without unrelated conversation content. |

## 6. Projects, worktrees, and execution buttons/APIs

Use a disposable Git repository for these tests.

| Action/tool/API operation | Inputs | Expected result |
|---|---|---|
| `projects.list` | `{}` | Lists registered projects and execution policies. |
| `projects.create` | Name, existing root path, optional Git metadata, validation, target policy. | Creates a server-owned project; invalid/outside paths fail closed. |
| `/v1/projects/update` | Project ID plus fields. | Updates only supplied fields. |
| `/v1/projects/remove` | Project ID. | Removes project metadata; it must not silently delete the user’s repository. |
| `projects.resolve-target` | Project ID, operation (`shell/edit/process/git`), access (`read/write`), optional target. | Returns the selected target and worktree requirement without executing anything. |
| `projects.promote-worktree` | Project/worktree and promotion details. | Performs only authorized clean fast-forward/cherry-pick promotion; dirty/conflicting work fails safely. |
| `project_diff` | Project/workspace context. | Returns bounded trusted diff information. |
| `project_validate` | Project/workspace context. | Runs configured validation and reports pass/fail output. |
| `project_commit` | Project/workspace and commit message. | Creates a commit only in the intended worktree. |
| `project_promote` | Project/workspace. | Promotes only after policy/cleanliness checks. |
| `/v1/projects/worktrees/create` | Project ID, optional target/name/base ref. | Creates isolated worktree and returns its directory. |
| `/v1/projects/worktrees/inspect` | Project ID and directory. | Returns worktree status/metadata. |
| `/v1/projects/worktrees/diff` | Project ID and directory. | Returns diff; no write occurs. |
| `/v1/projects/worktrees/publish-diff` | Project ID and directory. | Creates a trusted diff Artifact and returns its reference. |
| `/v1/projects/worktrees/commit` | Project ID, directory, message. | Commits in the selected worktree only. |
| `/v1/projects/worktrees/remove` | Project ID, directory, optional `force`/`deleteBranch`. | Removes the selected worktree; uncommitted work requires explicit force. |

## 7. Memory buttons and Agent memory tools

Use fake non-sensitive notes such as “test preference: tea”.

| Button/action ID/tool | Inputs | Expected result |
|---|---|---|
| `memory.embeddings.status` | `{}` | Reports whether the pinned semantic model is ready and whether vectors are stale/missing. |
| `memory.embeddings.refresh` | Optional scope/entry selection. | Attaches current-version vectors; unavailable model fails without losing notes. |
| `memory.preferences` | `{}` | Lists bounded user preference/habit records. |
| `memory.review` | Optional query/scope/limit. | Returns ranked/bounded remembered information. |
| `memory.correct` | Entry/relation identity, replacement fields, expected version. | Applies an optimistic correction; stale version fails and original remains. |
| `memory.preference.remember` | Preference text/category. | Persists a preference in the correct scope. |
| `memory.preference.forget` | Preference identity/category. | Removes only the selected preference. |
| `memory_recall` | Query and optional scope/limit. | Returns relevant memory; lexical fallback works if semantic inference is unavailable. |
| `memory_remember` | Note text and scope. | Persists a note without exposing unrelated scopes. |
| `memory_forget` | Entry identity/query. | Removes only the intended note. |
| `memory_remember_relation` | Subject, predicate, object, scope, optional context. | Creates/merges a semantic relation without duplicate context-split edges. |
| `memory_index_project_docs` | Project/document root. | Indexes permitted project docs; skips protected/unrelated paths. |

## 8. Skills, integrations, MCP, and conditional hooks

| Button/action ID/tool | Inputs | Expected result |
|---|---|---|
| `skills.install` / `skill_manage` | Approved local/remote skill source and metadata. | Installs only validated skill content; unsafe source is rejected. |
| `skill_view` | Skill ID. | Displays bounded skill metadata/content. |
| `integrations.connections` / `integrations.providers` | `{}` | Lists connection status/provider metadata without tokens. |
| `integrations.connect` | Provider and approved connection details. | Creates a connection through its owner; secrets remain Vault-owned. |
| `integrations.disconnect` | Connection ID. | Revokes/removes that connection. |
| `integrations_connections` | `{}` | Agent-readable connection summary only. |
| `integrations_invoke` | Integration ID and validated operation/input. | Executes an authorized integration operation; unsafe/network actions require permission. |
| `mcp.servers` / `mcp_servers` | `{}` | Lists MCP server metadata and health, never plaintext credentials. |
| `mcp.add-server` | Approved HTTPS/loopback server metadata. | Adds safe server; unsafe URL schemes/remote credentials are rejected. |
| `mcp.install` | Approved link/package. | Installs/records MCP metadata without bypassing ownership. |
| `mcp.remove-server` | Server ID. | Removes only selected server metadata. |
| `mcp.disconnect` | Server ID. | Closes active negotiated session. |
| `mcp.login` | Server ID/provider flow. | Performs credential flow without persisting plaintext token in metadata. |
| `mcp_search_registry` | Query. | Returns bounded registry matches. |
| `mcp_list_tools` | Server ID. | Lists negotiated tools. |
| `mcp_call_tool` | Server/tool/validated object arguments. | Calls tool through Permissions; malformed/non-object arguments fail. |
| `conditional-hooks.create` | Event predicate/action metadata. | Creates a validated hook. |
| `conditional-hooks.list` | `{}` | Lists hooks. |
| `conditional-hooks.remove` | Hook ID. | Removes selected hook. |
| `conditional_hook_invoke` | Hook ID/event input. | Invokes only the selected enabled hook and reports result. |

### Gateway, credentials, channels, and artifact-storage buttons

| Button/action ID | How to test | Expected result |
|---|---|---|
| `clients.start` | Run with a disposable loopback host/port, for example `{ "host": "127.0.0.1", "port": 0 }`; also try `0.0.0.0`. | Loopback gateway starts and returns the bound status. Every non-loopback bind is rejected; use a TLS reverse proxy for public exposure. |
| `clients.stop` | Run with `{}` after starting the gateway. | Gateway stops, closes client connections, and reports `running: false`. |
| `auth.model-credential` | From a trusted channel, run `{ "provider": "<disposable-provider>" }`, then submit a fake key through the protected prompt. | Key is validated and stored in Vault; response contains provider/request ID only. Non-channel invocation is rejected. |
| `auth.oauth-login` | From a trusted channel, run `{ "provider": "<supported-provider>" }` with a disposable OAuth/device-code account. | Authorization is delivered through the trusted channel and the token bundle is stored in Vault; codes are never model-visible. Unsupported provider/cancelled flow fails safely. |
| `channels.configure` | Configure a disposable channel with `enabled: false`, explicit allow lists, and `allowAll: false`; then re-enable it. | Non-secret settings persist, ingress remains default-deny, and the response lists credential *references* only. It never auto-trusts a sender. |
| `channels.capture-credential` | After `channels.configure`, start protected capture for one credential type and submit a fake value through the channel prompt. | Value is written directly to Vault and replaced by a reference in channel config; plaintext is absent from logs/model output. |
| `channels.whatsapp.setup` | Approve once on a disposable host. | User-space WhatsApp bridge tooling is installed/reused; no root or sudo access is requested. |
| `channels.reminder` (scheduled action) | Ask Scheduler to remind the current conversation once at a near-future ISO time with a non-sensitive message. | Task is bound to the originating conversation; when it fires exactly one reminder is delivered there. The model cannot choose another destination. |
| `artifacts.storage` | Run with `{}` before and after adding a disposable attachment. | Returns count, bytes, quota, available capacity, and utilization without file contents. |
| `artifacts.quota.set` | Set a disposable quota between 1 MiB and 1 TiB, then try values outside that range. | Valid quota persists; below/above bounds and non-integers are rejected. |
| `artifacts.cleanup-preview` | Run with `{ "olderThanDays": 1 }` after creating an old disposable artifact. | Lists exact eligible references and protects artifacts referenced by sessions; it performs no deletion. |
| `artifacts.cleanup` | Pass only references returned by the preview, then repeat with an unrelated/invalid reference. | Eligible references are deleted; protected, unknown, or malformed references are skipped/rejected safely and unrelated files remain. |

## 9. Scheduling, jobs, autonomy, refinement, spending, and self-improvement

| Button/action ID | Inputs | Expected result |
|---|---|---|
| `session.jobs.list` | `{}` | Lists active/background jobs with bounded status. |
| `session.jobs.cancel` | Job ID/reason. | Job becomes cancelled; active tools stop and cleanup runs. |
| `session.jobs.redirect` / `/v1/session-jobs/redirect` | Job ID and new instruction. | Queues a durable directive; job applies it at the steering boundary. |
| `session.transcript` | Session/job ID and bounded range. | Returns authorized transcript content only. |
| Scheduler create | With a configured scheduler/routing model, ask: “remind me at `<future ISO time>`: test reminder”. | Planner returns a validated `create` plan, asks for permission, stores an owner-scoped task, and reports next run/timezone. Ambiguous times must fail rather than guess. |
| Scheduler list | Ask “list my scheduled tasks” (planner operation `list`). | Only tasks visible to the requesting principal are returned; an empty list says `No scheduled tasks.` |
| Scheduler history | Ask for scheduler history, optionally naming a task and limit ≤100 (operation `history`). | Returns bounded newest-first run history; unknown/inaccessible task is rejected. |
| Scheduler cancel | Ask to cancel a known task (operation `cancel`). | Permission is requested, task is disabled/cancelled, and confirmation includes task ID/name. |
| Scheduler remove | Ask to remove a known task (operation `remove`). | Permission is requested and only that task is deleted; unknown/inaccessible task is rejected. |
| Scheduler missed-run policy/timezone | Create once, interval, and cron schedules using `coalesce`, `catch-up`, and `skip` where appropriate; inspect `system.status`. | `once` accepts ISO time, `interval` accepts positive milliseconds, cron uses the configured FRIDAY IANA timezone (not a model-supplied zone), and restart preserves task state. |
| `autonomy.run` | Objective, project/target, approval policy. | Starts an auditable autonomous run; dangerous actions still require approval. |
| `refinement.plan` | Target/refinement request. | Produces a plan without changing files. |
| `refinement.apply` | Approved plan. | Applies only planned changes and records history. |
| `refinement.history` | Target ID. | Lists prior refinements. |
| `refinement.rollback` | Refinement ID. | Reverts only that refinement when safe. |
| `spending.limits` | `{}` | Shows limits/current usage. |
| `spending.limit.set` | Scope/amount/currency/period. | Persists a validated limit. |
| `spending.limit.clear` | Limit ID/scope. | Removes selected limit. |
| `self-improvement.run` | Objective and approval. | Creates candidate, validates it, and records outcome. |
| `self-improvement.repair-from-diagnostics` | Diagnostic evidence and approval. | Attempts only safe repair plan; no silent destructive changes. |
| `self-improvement.ensure-capability` / `capability_ensure` | Capability ID. | Reports whether capability can be safely resolved. |
| `self-improvement.status` | `{}` | Shows current candidate/run status. |
| `self-improvement.history` | `{}` | Lists bounded prior runs. |
| `self-improvement.cancel` | Run/candidate ID. | Stops selected work and records cancellation. |

## 10. Permissions, devices, channels, voice, and observability

| Button/action ID | Inputs | Expected result |
|---|---|---|
| `permissions.identities` | `{}` | Lists trusted identities without private keys. |
| `permissions.trust-channel` | Channel identity and confirmation. | Adds exactly that trusted identity. |
| `permissions.revoke-channel` | Channel identity. | Revokes it; future actions require authorization again. |
| `devices.list` | `{}` | Lists paired devices and revocation state. |
| `devices.pairings` | `{}` | Lists pending pairings/challenges without private material. |
| `devices.approve-pairing` | Pairing ID/approval. | Approves only selected pending pairing. |
| `devices.revoke` | Device ID. | Revokes device and invalidates future challenges. |
| Channel configuration buttons | Choose Telegram, Discord, Slack, WhatsApp, Signal, Email, Teams, Google Chat, or SMS; choose enable/disable/remove/back. | Choice is persisted; secrets are not printed; disable preserves config, remove deletes selected config, back makes no change. |
| `voice.setup` | STT/TTS provider/model and CPU/GPU choice. | Persists provider settings; missing credentials/dependencies produce a repair message. |
| `observability.logs` | Filters/limit. | Returns bounded structured logs. |
| `observability.usage` | Optional range/provider. | Returns token/cost usage totals. |
| `observability.usage-records` | Optional range. | Returns bounded usage records. |
| `observability.metrics` | `{}` | Returns metrics snapshot. |
| `observability.spans` | `{}` | Returns bounded trace/span summaries. |
| `audit.verify` | `{}` | Verifies audit-ledger integrity. |
| `audit.records` | Filters/limit. | Lists records with sensitive values redacted. |
| `alerts.list` | `{}` | Lists alert subscriptions. |
| `alerts.subscribe` | Event filter/destination. | Creates a subscription. |
| `alerts.remove` | Subscription ID. | Removes selected subscription. |
| `events.replay` | Cursor/limit. | Replays events from the cursor without duplication. |
| `events.consumers` | `{}` | Lists consumer checkpoints. |
| `events.delivery-history` | Filter/limit. | Shows delivery outcomes. |
| `events.compact` | Confirmation/options. | Compacts only eligible event history. |
| `webhooks.routes` | `{}` | Lists configured webhook routes without secrets. |
| `webhooks.start` | Loopback/approved bind settings. | Starts listener on approved interface. |
| `webhooks.stop` | `{}` | Stops listener and closes connections. |

### Voice setup choice coverage

Run `friday setup voice` with disposable settings and exercise each provider path separately.

| Choice | Expected result |
|---|---|
| STT: Local / OpenAI / Deepgram | Presents the provider’s model choices, validates language (`auto` or a code), provisions local dependencies/models when selected, and verifies a transcription probe. Hosted keys are hidden and Vault-owned. |
| STT: Disabled | Saves no active STT configuration and does not request an STT key. |
| TTS: Local / OpenAI / ElevenLabs | Presents model and voice choices, verifies an audio synthesis probe, and stores hosted credentials only in Vault. ElevenLabs requires a voice ID. |
| TTS: Disabled | Saves no active TTS configuration and does not request a TTS key. |
| Local Chatterbox compute | On a detected NVIDIA GPU, test CPU and CUDA choices; without a GPU, confirm the CPU-only message. No OS GPU driver is installed by setup. |
| Invalid/oversized reference clip | Provide a missing, non-file, empty, or >20 MiB reference path. Setup rejects it without publishing partial voice settings. |

## 11. Agent tools

### Core tools

| Tool | Test input | Expected result |
|---|---|---|
| `bash` | `{"command":"printf 'hello\\n'"}` | Returns `hello`; output is bounded. Network remains blocked in Sandbox unless explicitly approved. |
| `edit` | A disposable file plus one unique `oldText`/`newText` replacement. | File changes exactly once and returns a diff. Duplicate/missing old text fails without partial write. |
| `process` start | `{"action":"start","command":"sleep 2"}` | Starts a supervised process for the current main-agent run. Subagents are rejected. |
| `process` list/status/logs/stop | Use the returned process ID. | Reports state/logs, then stops only selected process. |
| `ipython` | `{"code":"print(2 + 2)"}` | Returns `4`; kernel/session cleanup occurs at run end. |
| `ask_user` | A non-secret question with choices. | User response is returned; cancellation/timeout is explicit. Never ask for passwords or OTPs. |
| `delegate_to_agent` | Independent bounded task. | Creates visible subagent handoff and reports completion/failure. |

### Memory/project/skill/integration tools

Run the tools listed in Sections 6–8 from an Agent turn. Confirm that the Agent receives only the selected project/scope and that permission prompts appear for writes/network actions.

## 12. Client Gateway HTTP and WebSocket tests

Start the gateway through the client action or the configured runtime. Use a paired disposable device. Every protected endpoint must be called with the device challenge/signature flow; unauthenticated calls must fail.

### Basic and authentication endpoints

| Endpoint | Method/body | Expected result |
|---|---|---|
| `/health` | GET | 200 health response. |
| `/v1/pairings` | POST `{deviceId,name,type,publicKey}` | 202 with pairing ID/challenge/expiry. |
| `/v1/auth/challenge` | POST `{deviceId}` | 200 challenge. |
| `/v1/events/replay` | POST authenticated `{deviceId,challenge,signature,afterSequence}` | 200 events plus latest sequence. |
| `/v1/stream` authentication | WebSocket; first message `client.authenticate` | `client.ready`, replayed events, then live events. Missing/late authentication returns `client.error` and closes with code 4401 (including authentication timeout). |
| `/v1/stream` WebRTC offer/answer/ICE | After authentication, send each of `webrtc.offer`, `webrtc.answer`, and `webrtc.ice` with `targetDeviceId`, `sessionId`, and a disposable payload while the target device is connected. | Target receives the same signal with `sourceDeviceId` populated; sender cannot forge it. An unknown target returns a bounded `client.error`. |
| `/v1/stream` invalid message | After authentication send a non-WebRTC message, malformed JSON, or an oversized payload. | Server returns a bounded `client.error` and does not relay or crash. |

### Computer endpoints

| Endpoint | Expected result |
|---|---|
| `/v1/computer/status` | Status plus Doctor; no raw page text/secrets. |
| `/v1/computer/nodes` | Refreshed bounded node snapshots. |
| `/v1/computer/screens` | Node/screen descriptors only. |
| `/v1/computer/leases` | Current screen/control leases. |
| `/v1/computer/observe` | Safe observation with safety attestation; no raw screenshot bytes or input values. |
| `/v1/computer/takeover` | Human holder is recorded for selected lease; Agent input pauses. |
| `/v1/computer/human-activity` | Refreshes hand-back timer without recording keystrokes. |
| `/v1/computer/hand-back` | Fresh observation and new generation; stale action is not replayed. |

### Profile/conversation/project/turn endpoints

Test every endpoint with valid and missing IDs:

- `/v1/agent-profiles/list`, `/v1/agent-profiles/create`, `/v1/agent-profiles/update`, `/v1/agent-profiles/remove`
- `/v1/conversations/list`, `/v1/conversations/create`, `/v1/conversations/update`, `/v1/conversations/mark-read`
- `/v1/conversations/mentions/resolve`
- `/v1/conversations/threads/create`, `/v1/conversations/threads/reply`
- `/v1/conversations/reactions/add`, `/v1/conversations/reactions/remove`, `/v1/conversations/reactions/list`
- `/v1/projects/list`, `/v1/projects/create`, `/v1/projects/update`, `/v1/projects/remove`, `/v1/projects/resolve-target`
- `/v1/projects/worktrees/create`, `/inspect`, `/diff`, `/publish-diff`, `/commit`, `/remove`
- `/v1/turns`
- `/v1/session-jobs/redirect`

Channel binding management (`conversations.channel-bindings`, `conversations.bind-channel`, and
`conversations.unbind-channel`) is currently exposed through the system-action surface, not as a
separate HTTP route; test those action IDs in Section 5.

Expected for every endpoint:

- Valid input returns the documented 200/201/202 response and bounded JSON.
- Missing/invalid required fields return 400 with a safe error code/message.
- Unauthenticated requests are rejected.
- No plaintext credential, private key, password, OTP, CAPTCHA content, or unrelated private path appears.

## 13. Linux / Raspberry Pi Computer (Phase 5)

Run these tests on Debian/Raspberry Pi OS or Ubuntu/Kubuntu as a normal user, never root.

### Install and deployment buttons

| Action | Steps | Expected result |
|---|---|---|
| Compatibility setup | `scripts/setup-linux-computer.sh compatibility` | Installs user units/config under `~/.config`, sets loopback CDP variables, enables headless Sway, and prints the smoke command. |
| Managed setup | `scripts/setup-linux-computer.sh managed` | Installs files but does not replace the current desktop; prints the Sway command. |
| Invalid setup mode | `scripts/setup-linux-computer.sh invalid` | Exit 2 with usage; no files changed. |
| Smoke | `scripts/smoke-linux-computer.sh` | Prints `PASS: Sway Agent output and loopback Chromium CDP are healthy.` plus socket/CDP values. |
| Smoke timeout | Set `FRIDAY_COMPUTER_SMOKE_ATTEMPTS=1` on an unready host. | Fails with a bounded readiness message; it does not loop forever. |
| Real browser conformance | `npx tsx scripts/conformance-linux-computer.ts` | Prints `PASS: real Chromium CDP navigate/click/type/press and provider safety conformance are healthy.` |
| Doctor provider check | `FRIDAY_COMPUTER_PROVIDER=linux-sway npm run friday -- doctor` | Reports Linux Computer health, Sway outputs, Chromium CDP, and any actionable warning. |

### Provider behavior buttons/actions

| Action | Test | Expected result |
|---|---|---|
| `computer.status` | Run with a healthy provider. | Shows node availability, resources, browser readiness, screens, and leases. |
| `computer.doctor` | Run before/after Sway or Chromium is stopped. | Healthy host has no provider issue; stopped dependency is reported as degraded/unavailable. |
| `computer.node.refresh` | Supply node ID. | Returns fresh telemetry/screens/browser state. |
| `computer.node.restart` | Run with no active lease, using a test host. | Restarts provider-owned user services and returns refreshed node state. Active leases are rejected. |
| `computer.node.update` | Run with no active lease. | Performs provider-managed service refresh/update action; active leases are rejected. |
| `computer.node.reset-managed` | Run with no active lease and disposable profile. | Removes/recreates only the FRIDAY browser profile; it never resets the OS or unrelated Chrome profile. |
| `computer.takeover` | Acquire an Agent screen lease, then take it over. | Holder becomes human and Agent action is paused. |
| `computer.human-activity` | Send activity repeatedly. | Hand-back timer is refreshed; no key/text payload is stored. |
| `computer.hand-back` | Stop interacting and hand back. | Current page is freshly observed, generation increments, stale action is not replayed, Agent can continue. |
| `computer_observe` | Observe active leased screen. | Returns bounded safe metadata and attestation. |
| `computer_browser navigate` | Navigate to a loopback test page. | Uses CDP, waits for document readiness, returns fresh observation. |
| `computer_browser click` | Click a safe button by selector. | Uses CDP mouse events; page action occurs once; no `element.click()` shortcut. |
| `computer_browser type` | Type non-secret text into a safe input. | Uses CDP input; value is not included in observation. |
| `computer_browser press` | Press Enter/Tab/Arrow key on safe page. | Named key metadata is sent and page reacts. |
| Protected click/type/press | Target an input/selector containing password, OTP, token, PIN, CAPTCHA, or protected focus. | Provider refuses before dispatch and tells tester to use human takeover. |
| Human takeover login wall | Use a synthetic login page; Agent reaches wall; human enters fake credentials; hand back. | Secrets/keystrokes/sensitive screenshot are absent; same Session Job resumes from fresh state without replay. |
| Resource pressure | Configure low memory/CPU/renderer thresholds or occupy Agent screens. | Admission reports `WAITING_FOR_COMPUTER`; job resumes automatically when capacity returns. |
| Two-Agent screens | Managed Sway with two headless outputs; acquire two leases. | Agents receive distinct screens/targets while sharing filesystem/browser profile. |

## 14. Security and negative tests

These are mandatory. A failure is a release blocker.

- Put fake values such as `password=hunter2`, `otp=123456`, `token=abc123`, and `captcha=blue-car` in a synthetic page. Observe it. Expected: values are redacted/omitted from DOM, URL, tab title, accessibility text, process text, logs, gateway response, and event payload.
- Try `computer_browser` typing into `input[name=password]`, an OTP field, and a CAPTCHA field. Expected: no CDP input event is dispatched.
- Try a non-loopback `FRIDAY_COMPUTER_CDP_URL`. Expected: provider construction/Doctor rejects it.
- Try browser navigation with `javascript:`, `file:`, embedded username/password, or malformed URL. Expected: rejected before navigation.
- Try edit paths outside the selected project/worktree. Expected: rejected and no file changes.
- Try process start as a subagent. Expected: rejected.
- Try process lifetime over 3600 seconds. Expected: rejected.
- Start a background Computer process, end/cancel the run, then inspect the host. Expected: provider cleanup stops the run-owned process.
- Change human/Agent control during a browser action. Expected: action is interrupted, not replayed; a fresh observation is required.
- Call every protected gateway endpoint without authentication. Expected: rejection; no data leakage.
- Supply malformed JSON, unknown fields where forbidden, oversized text, invalid IDs, and duplicate parameters. Expected: bounded 400/error response; process remains healthy.

## 15. Recovery and restart tests

1. Start FRIDAY and create a conversation, profile, project, memory note, and background Session Job.
2. Restart FRIDAY normally.
3. Run `doctor`, `system.status`, and `session.jobs.list`.
4. Resume the job and inspect the conversation/memory/project.

Expected:

- Durable records remain present.
- A waiting Computer job restores its node/reason context and returns to running when capacity is available.
- No duplicate turn, event, process, or reaction is created.
- Provider cleanup runs before a completed Computer run is reported.

## 16. Tester sign-off checklist

| Area | Pass/Fail | Evidence |
|---|---|---|
| CLI/help/version/setup |  |  |
| Doctor and diagnostics |  |  |
| Backup/encryption/restore |  |  |
| Vault recovery |  |  |
| Profiles/conversations |  |  |
| Projects/worktrees/validation |  |  |
| Memory and semantic index |  |  |
| Skills/integrations/MCP |  |  |
| Permissions/devices/channels |  |  |
| Jobs/scheduler/autonomy/refinement |  |  |
| Gateway HTTP/WebSocket |  |  |
| Linux Computer deployment |  |  |
| Browser safety/takeover |  |  |
| Restart/recovery |  |  |

## 17. Bug report format

If any test fails, report:

```text
Test ID/action:
Date/time and OS:
Commit/version:
Exact command or button input:
Expected result:
Actual result:
Exit code / HTTP status:
Relevant redacted logs:
Reproduction steps:
Severity: blocker / high / medium / low
```

Do not attach real credentials, private keys, unredacted browser screenshots, or private user data.
