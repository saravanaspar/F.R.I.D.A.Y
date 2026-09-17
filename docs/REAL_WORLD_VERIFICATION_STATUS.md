# F.R.I.D.A.Y Real-World Verification Status and Ordered Release Checklist

Last updated: 2026-09-16
Reviewed checkpoint: `01c050d` (`chore: checkpoint Friday bug fixes for review`)

## Purpose

This document tracks **real user-facing end-to-end verification only**.

Automated tests, mocks, typechecks, static review, and build success are useful evidence, but they do **not** change an item to **Verified** here. An item becomes Verified only after the actual installed FRIDAY binary has been exercised on a real supported machine through the same path a normal user will use.

The intended normal-user contract is:

1. Install the FRIDAY release binary.
2. Run the normal FRIDAY setup/onboarding flow.
3. Enter credentials, account identifiers, and other user-owned configuration when requested.
4. Complete explicit local OS authentication when a narrowly scoped privileged operation genuinely requires it.
5. Use FRIDAY from the configured trusted channel/client.

A normal user must **not** need a source checkout, `scripts/*.sh`, manual copying of files from `deploy/`, manual environment-file editing, or developer-only commands to make a normal advertised feature work. Developer/release test scripts may still exist internally, but they are not an acceptable normal-user setup dependency.

---

## Current real-world verification status

| Area | Status | Current evidence / note |
| --- | --- | --- |
| First-run onboarding + credential setup flow | **VERIFIED / FIXED** | Real flow has been exercised and the credential/model setup issue is considered fixed. Keep it in regression coverage after future setup changes. |
| Telegram channel | **ONGOING VERIFICATION** | Current live verification channel. Finish the Telegram matrix before using another channel to judge shared runtime behavior. |
| Discord | **NOT VERIFIED** | Real channel verification not yet completed. |
| Slack | **NOT VERIFIED** | Real channel verification not yet completed. |
| WhatsApp | **NOT VERIFIED** | Real channel verification not yet completed. |
| Signal | **NOT VERIFIED** | Real channel verification not yet completed. |
| Email | **NOT VERIFIED** | Real channel verification not yet completed. |
| Microsoft Teams | **NOT VERIFIED** | Real channel verification not yet completed. |
| Google Chat | **NOT VERIFIED** | Real channel verification not yet completed. |
| SMS / Twilio | **NOT VERIFIED** | Real channel verification not yet completed. |
| Main-model reasoning + routing | **NOT VERIFIED** | Must be exercised through a real trusted ingress turn. |
| Approval / permission lifecycle | **NOT VERIFIED** | Code fixes exist, but the complete live lifecycle still needs verification. |
| Durable Session Jobs / long-running work | **NOT VERIFIED** | Includes retry, cancel, redirect, restart, and delivery behavior. |
| Runaway tool-loop protection / silent-agent bug | **NOT VERIFIED** | Automated regression evidence exists, but the original real failure path has not yet been re-run successfully. |
| Voice STT | **NOT VERIFIED** | Must be verified with a real audio/voice message after provider/model setup. |
| Voice TTS | **NOT VERIFIED** | Candidate code now has a trusted originating-channel `speak_reply` path and Telegram audio delivery; it remains unverified until a real installed binary sends playable synthesized audio. |
| Linux Computer / browser control | **NOT VERIFIED** | Candidate code now has binary-owned X11 setup and shared-profile browser windows; the complete installed-binary flow still requires real-machine verification. |
| Browser auto-detection + shared normal-profile window | **NOT VERIFIED** | Candidate code detects direct/Snap/Flatpak Chromium-family launchers and defaults to a FRIDAY-owned window in the normal browser profile. No profile copy/seeding is used in shared mode. Real-machine verification is still required. |
| Execution / private Python | **NOT VERIFIED** | Real tool execution and cleanup still required. |
| Sandbox | **NOT VERIFIED** | Real isolation/network-policy behavior still required. |
| Artifacts / attachments | **NOT VERIFIED** | Real ingress, persistence, retrieval, limits, and cleanup required. |
| Memory | **NOT VERIFIED** | Real remember/retrieve/correct/forget/restart behavior required. |
| Agent Profiles / personas / conversations | **NOT VERIFIED** | Real persistent behavior required. |
| Projects / worktrees / Git workflow | **NOT VERIFIED** | Real project isolation, diff, commit, promotion, cleanup required. |
| Skills | **NOT VERIFIED** | Real discovery/install/invocation/trust behavior required. |
| MCP | **NOT VERIFIED** | Real server discovery/auth/tool invocation/disconnect required. |
| Integrations | **NOT VERIFIED** | Real connect/use/disconnect required. |
| Scheduling / recurring work | **NOT VERIFIED** | Real one-shot, recurring, timezone, restart behavior required. |
| Alerts / conditional hooks | **NOT VERIFIED** | Real trigger and delivery behavior required. |
| Autonomy / refinement / spending controls | **NOT VERIFIED** | Real permission/budget/history/rollback behavior required. |
| Client Gateway / devices / WebSocket | **NOT VERIFIED** | Real authenticated client/device flow required. |
| Webhooks | **NOT VERIFIED** | Real start/auth/request/stop behavior required. |
| Diagnostics / observability / audit / events | **NOT VERIFIED** | Real status, redaction, replay/history behavior required. |
| Backup / restore / Vault recovery | **NOT VERIFIED** | Must be tested on disposable real state before release sign-off. |
| Self-improvement / generation / lifecycle handoff | **NOT VERIFIED** | Real candidate, evaluation, promotion, restart, resume, rollback required. |
| Crash/restart recovery | **NOT VERIFIED** | Real process failure and durable-state recovery required. |
| Always-on Linux service installation | **NOT VERIFIED** | Candidate code adds binary-owned `friday setup service` and embeds the user-service unit; real install/reboot behavior is not yet verified. |

**Rule:** until a row is explicitly changed after a successful real run, it remains **NOT VERIFIED** even if its unit/integration tests pass.

---

## Initial review findings addressed in this candidate

The following implementation changes address the code-review findings. **None of these statements upgrade the real-world status table above.** They describe the candidate implementation that must now be exercised using the ordered plan below.

### A. Computer setup is binary-owned

`friday setup computer` is now the supported release-user path. The old `scripts/setup-linux-computer.sh` file is only a developer compatibility wrapper that delegates to the binary command. Normal-user documentation and Doctor repair guidance point to the binary-owned setup path.

### B. Required Computer/service assets are embedded in the release binary

The Computer AT-SPI helper and the bounded systemd unit files are declared as binary assets. `friday setup service` installs the always-on user service without requiring a repository checkout. The isolated `managed-cdp` fallback service is also binary-owned.

### C. Computer prerequisites use the restricted privilege broker

On supported Debian/Ubuntu systems, Computer setup checks its fixed prerequisite set (`wmctrl`, `xdotool`, X11 utilities, AT-SPI/Python support) and, when the user selected the restricted broker, installs only the approved package operation through that broker. Privilege mode `none` fails with explicit remediation rather than silently escalating.

### D. Computer configuration is persisted in FRIDAY runtime settings

Provider, browser mode/launcher, Agent desktop indexes, and the managed fallback settings are persisted through FRIDAY-owned runtime settings. Shared mode deliberately does not persist a Human browser-profile path because it uses the browser's normal profile through normal **New Window** behavior.

### E. Shared browser mode replaces profile copying as the default

The broken one-time profile seed/migration design is no longer the default architecture. In `shared` mode FRIDAY asks the user's existing/default Brave, Chrome, or Chromium installation to create a new window while the Agent desktop is active. That window belongs to the same normal browser profile, so current cookies/logins are shared just as they are for the browser's own **New Window** command.

FRIDAY records an X11 ownership marker only on the window it created and cleanup re-checks that marker before closing the window. Pre-existing Human windows are not broad-killed. The isolated `managed-cdp` mode remains an explicit fallback and uses its own FRIDAY profile without copying/synchronizing the Human profile.

### F. Browser launch detection covers packaging form

Detection produces a launch descriptor rather than assuming a plain executable. Direct browser commands cover ordinary and Snap-installed launchers available on `PATH`; Flatpak Brave, Chrome, and Chromium are represented as `flatpak run <app-id>`. Every claimed packaging form still needs a real-machine test.

### G. TTS now has a trusted channel-output path

Voice contributes a bounded `speak_reply` tool that can synthesize only for the current turn and sends audio only to the originating trusted channel conversation. Telegram implements bounded multipart `sendVoice`/`sendAudio` delivery. This makes real TTS verification possible, but TTS stays **NOT VERIFIED** until the installed binary actually sends playable synthesized audio in Telegram.

### H. Automated evidence is supporting evidence only

Static binary-asset, plugin-boundary, shell-syntax, Python-helper compile, and diff checks can support the candidate. Full dependency-backed typecheck/test/build must also pass, but neither automated result changes a row to **VERIFIED** without the matching real user test.

---

# Ordered real-world verification plan

Follow this order. Do not skip ahead when a stage is a dependency for the next stage. Keep one redacted evidence record per numbered stage: commit/version, OS/session, exact user action, expected result, actual result, and relevant redacted logs.

## Stage 0 — Freeze the exact candidate

1. Build/publish one candidate from the exact commit being tested.
2. Record the commit SHA, FRIDAY version, OS, desktop session, architecture, and test account names.
3. Use a clean or disposable normal-user account where possible.
4. Do **not** clone the FRIDAY repository on the normal-user test account for product-flow verification.
5. Install only the release binary through the normal release installer.
6. Run `friday --version` and confirm it matches the candidate.
7. Run `friday --help` and confirm all normal-user maintenance/setup surfaces are reachable from the binary.
8. Fail this stage if a normal advertised capability requires a source-tree script/file before the feature can even be configured.

**Pass gate:** installed binary is runnable and the test environment represents a normal user, not a developer checkout.

## Stage 1 — Regress the already-fixed onboarding + credential flow

This area is already marked Verified/FIXED, but rerun it once on each release candidate because later setup changes can regress it.

9. Start from a fresh `FRIDAY_HOME`/normal user state.
10. Run `friday setup`.
11. Choose Quick setup first for the primary release test.
12. Choose the routing/model provider you actually intend to use for the rest of verification.
13. Enter an intentionally invalid disposable credential first and confirm it is rejected without being stored as a working credential.
14. Enter the valid credential through the hidden/protected prompt.
15. Confirm the model list is populated from the credential-visible provider models where live discovery is supported.
16. Select the routing model.
17. Configure Telegram as the first ingress channel.
18. Enter the Telegram bot credential through the protected setup prompt.
19. Enter the exact allowed sender ID.
20. Explicitly confirm that exact Telegram principal as the initial operator.
21. Choose the host privilege policy intentionally. Use `broker` on the primary Linux capability test machine so automatic approved dependency installation can be exercised later; use `none` in a separate negative test.
22. Finish setup.
23. Rerun `friday setup` and confirm valid saved credentials/settings are reused rather than silently reset.
24. Confirm setup logs do not contain plaintext credentials.

**Pass gate:** onboarding still behaves exactly as the previously verified/fixed flow. Keep status Verified only if this regression remains clean.

## Stage 2 — Finish Telegram channel verification first

Telegram is the current ongoing verification channel. Complete it before judging shared runtime features through other transports.

25. Start `friday` using only the installed binary.
26. Send a simple Telegram text message such as `reply with exactly TELEGRAM-OK`.
27. Confirm exactly one reply arrives in the correct chat/thread.
28. Send two normal messages quickly and confirm both are admitted in order without cross-contamination.
29. Restart FRIDAY and send another message; confirm Telegram resumes without replaying old completed messages.
30. Send from an untrusted Telegram sender/account and confirm it cannot execute privileged/operator actions.
31. Trigger an action that requires approval.
32. Press **Approve** once; confirm the action executes once.
33. Confirm the resolved approval message is deleted. If Telegram permissions prevent deletion, confirm the inline keyboard is removed so it cannot be pressed again.
34. Trigger another approval and press **Deny**; confirm the action does not execute.
35. Press or replay a stale approval callback and confirm it is rejected as no longer valid.
36. Reproduce a durable retry/redelivery of the same admitted turn/job where possible; confirm it does **not** create a second routine Computer/control approval for the same logical turn.
37. Trigger a bounded protected question/prompt and confirm the selected answer is recorded once and the controls are removed after resolution.
38. Send a Telegram image attachment and confirm it is ingested as an artifact without exposing transport credentials.
39. Send a Telegram document attachment and confirm bounded artifact intake works.
40. Leave the Telegram runtime active while later stages run; it is the primary observation/control channel for the rest of this checklist.

**Pass gate:** Telegram text ingress/egress, trust, approvals, retry behavior, restart behavior, and retrievable attachments all work in the real bot account.

## Stage 3 — Main model, Routing, Turn Loop, and the previous silent-agent bug

41. Ask a normal reasoning question and confirm the configured main model produces a response.
42. Ask a follow-up that depends on the previous turn; confirm session context is preserved.
43. Start a clearly unrelated request and confirm Routing can select/create the appropriate destination without contaminating another conversation.
44. If router-only bootstrap is supported in the candidate, test one fresh setup without a main model and confirm admin/setup actions work while general reasoning clearly asks for main-model configuration.
45. Configure the main model from the trusted Telegram channel and confirm protected credential capture works when required.
46. Restart FRIDAY and confirm routing/main-model settings persist.
47. Re-run the original or closest reproducible task that previously caused the Agent to continue making Computer/tool calls for many minutes without replying.
48. While that task is active, send a second Telegram message from the same trusted operator and observe whether ingress remains healthy according to the intended serialization/job model.
49. Confirm the runaway task either completes normally or hits the configured bounded tool-loop ceiling and returns a visible failure/status instead of remaining silent indefinitely.
50. Confirm cleanup occurs after the bounded failure and a new Telegram request can execute normally.

**Pass gate:** no indefinite silent loop; bounded failure is visible and the channel/runtime remains usable afterward.

## Stage 4 — Permissions and protected-action lifecycle

51. Set permission mode to `ask` for the primary test.
52. Run a read-only operation and confirm no unnecessary mutation approval is requested.
53. Request a workspace file write and confirm the correct approval is requested.
54. Approve it and confirm exactly one write occurs.
55. Repeat with Deny and confirm no write occurs.
56. Trigger a network-bearing operation and confirm network authority is separately represented when required.
57. Trigger protected credential capture and confirm secret input is not echoed into chat/transcript/log output.
58. Restart FRIDAY with a pending/stale protected interaction and confirm stale actions cannot be replayed as fresh authority.
59. Confirm `permissions.identities` shows only the expected trusted identities.
60. Revoke a disposable trusted identity and confirm it immediately loses operator authority.

**Pass gate:** approvals are scoped, single-use, restart-safe, and do not leak secrets.

## Stage 5 — System status, Doctor, diagnostics, observability, audit, and Events

61. From Telegram, request `system.status` and confirm every loaded plugin returns a bounded status section.
62. Request the operator dashboard/status equivalent and confirm jobs/approvals/schedules/failures are bounded and understandable.
63. Run `friday doctor` locally with FRIDAY stopped or in the documented safe state.
64. Confirm Doctor reports real missing dependencies/configuration accurately without making hidden changes.
65. Run diagnostic review from the trusted channel and confirm setup/runtime failures are redacted.
66. Inspect observability metrics/spans/log summaries through their actions and confirm no plaintext credentials, OTPs, protected input values, or arbitrary private file content appears.
67. Verify the audit ledger and confirm integrity verification succeeds.
68. Exercise Events delivery history/replay on disposable events and confirm replay does not rerun already-completed external work incorrectly.

**Pass gate:** operational evidence is useful, bounded, and secret-redacted.

## Stage 6 — Execution, private Python, processes, and artifacts

69. Provision private execution Python through the binary/system action, not a repository script.
70. Rerun provisioning and confirm it is idempotent.
71. Ask FRIDAY to create a disposable file inside the selected workspace.
72. Read it back through FRIDAY.
73. Attempt to write outside the selected project/workspace boundary and confirm rejection.
74. Start a short background process through the approved execution surface.
75. Query its status/output.
76. Stop/cancel it and confirm no orphan process remains.
77. Start a process tied to a Session Job, cancel/end the run, and confirm run-scoped process cleanup executes.
78. Upload a small supported artifact and confirm it persists by opaque reference.
79. Try an oversized/invalid artifact and confirm bounded rejection.
80. Run artifact storage/quota/cleanup-preview and cleanup on disposable artifacts.

**Pass gate:** execution is bounded to the intended workspace/run and artifact lifecycle behaves safely.

## Stage 7 — Memory and semantic retrieval

81. Ask FRIDAY to remember one harmless preference with a unique phrase.
82. Start a new conversation/session and ask for that preference; confirm retrieval.
83. Restart FRIDAY and ask again; confirm persistence.
84. Correct the preference and confirm the old value is no longer used as current truth.
85. Forget the preference and confirm it is no longer retrieved as active memory.
86. Provision/refresh embeddings through the binary-owned setup/action.
87. Test a semantic paraphrase query that should retrieve the stored concept without exact words.
88. Review memory state and confirm unrelated private content is not dumped into model context.

**Pass gate:** remember/correct/forget/restart/semantic retrieval all behave predictably.

## Stage 8 — Agent Profiles, personas, conversations, projects, and worktrees

89. Create a disposable Agent Profile.
90. Update it, select/use it, and verify the expected behavior applies only where intended.
91. Remove it and confirm references fail safely afterward.
92. Switch persona in an explicit user turn and confirm the next model turn reflects the selected persona without changing security policy.
93. Create two conversations and confirm transcripts/context remain separate.
94. Bind a disposable channel conversation where supported, inspect bindings, then unbind it.
95. Create a disposable project pointing at a disposable Git repository.
96. Resolve/select its execution target.
97. Create an isolated worktree.
98. Ask FRIDAY to make one harmless code/text change in that worktree.
99. Inspect the diff.
100. Commit the disposable change through the project/worktree surface.
101. Confirm the main checkout was not changed before promotion.
102. Promote/publish only through the intended bounded action.
103. Remove the disposable worktree and confirm cleanup.

**Pass gate:** profile/conversation/project boundaries remain isolated and durable.

## Stage 9 — Sandbox

104. Provision the configured SandboxProvider using `friday setup sandbox` or the typed setup action from the binary.
105. Rerun setup and confirm idempotence.
106. Execute a harmless command in the sandbox and confirm it cannot access protected FRIDAY state outside the allowed boundary.
107. Attempt outbound network access with network disabled and confirm it is blocked.
108. Explicitly request/approve an allowed network-bearing sandbox operation and confirm only that authorized path succeeds.
109. Trigger a sandbox failure and confirm FRIDAY reports a bounded repair hint rather than silently falling back to unsandboxed execution.

**Pass gate:** isolation and network policy are real, not only configuration flags.

## Stage 10 — Voice: local model installation, Telegram STT, then TTS

Use Telegram because it already supports retrievable audio attachments and is the current primary verified channel path.

110. From a normal binary installation, configure Voice through `friday setup voice` or the trusted `voice.setup` action.
111. For the first local test, select local Whisper STT (`base-q5_1` is a practical baseline) and a lightweight local TTS choice such as Piper.
112. Confirm FRIDAY detects missing supported host dependencies itself.
113. With privilege mode `broker`, confirm the approved fixed dependency set is installed through the restricted broker; do not manually run a repository `.sh` helper.
114. Confirm the selected local model files are downloaded/provisioned into FRIDAY-owned private tooling automatically.
115. Confirm setup performs its built-in STT/TTS provider probe successfully.
116. Restart FRIDAY so Voice reloads the saved settings.
117. Send a Telegram voice note containing a unique harmless sentence such as `Friday voice test seven four nine green apple`.
118. Ask FRIDAY to repeat or summarize exactly what it heard.
119. Confirm the recognized transcript matches the spoken content closely enough to prove the Telegram attachment -> Artifact -> Voice STT -> Turn Loop path is real.
120. Restart FRIDAY and send a second voice note; confirm local STT still works without reprovisioning or network download.
121. Do **not** mark TTS end-to-end Verified merely because setup synthesized its internal probe.
122. Send Telegram text such as `reply with a voice message saying FRIDAY TTS TEST` and require FRIDAY to use the channel-bound `speak_reply` path.
123. Confirm Telegram receives one or more playable synthesized-audio messages containing the requested phrase. For an MP3/OGG-capable TTS provider, confirm Telegram uses its native voice-note path when requested; WAV may appear as a normal playable audio attachment.
124. Confirm the audio is sent only to the conversation that originated the request and cannot be redirected by model-supplied text to another chat/account.
125. Restart FRIDAY and repeat to prove TTS configuration persistence.
126. Repeat STT with hosted OpenAI and/or Deepgram if those providers are release targets.
127. Repeat TTS with hosted OpenAI and/or ElevenLabs if those providers are release targets.
128. Test Chatterbox separately: attach exactly one clean reference audio clip from Telegram, configure it as the cloning reference, synthesize a harmless test sentence, and confirm the cloned voice path works without exposing the reference outside FRIDAY private state.
129. If NVIDIA CUDA is available, test explicit CPU selection and explicit CUDA selection separately; FRIDAY must never select CUDA merely because a GPU exists.

**Pass gate:** STT requires a real incoming Telegram audio turn. TTS requires a real outgoing playable audio response; setup probe alone is insufficient.

## Stage 11 — Linux Computer setup automation gate

Do not perform the final Computer behavior tests until this setup gate passes.

130. Start from a supported real Linux X11 desktop user account with no FRIDAY source checkout.
131. Install only the FRIDAY binary.
132. Run `friday setup computer` from an unrelated working directory, not from the FRIDAY repository.
133. Confirm FRIDAY detects the X11/EWMH session and clearly rejects unsupported Wayland without installing a hidden Sway/VNC fallback.
134. Confirm FRIDAY detects the required Computer host dependencies.
135. With broker mode selected, confirm the fixed supported dependency set is installed automatically through the restricted broker; do not run a source `.sh` helper.
136. Confirm no normal-user instruction tells you to run `scripts/setup-linux-computer.sh` or copy a unit from `deploy/`.
137. Confirm FRIDAY detects the actual supported default browser and its packaging form.
138. Test native Brave first on the primary machine; test Chrome/Chromium separately if they are claimed supported.
139. Test any claimed Snap and Flatpak variants separately and confirm they launch, not merely that their files are detectable.
140. Keep an already logged-in Human browser window open while running setup; confirm setup does **not** ask you to close it and does not copy its profile into a FRIDAY profile in default `shared` mode.
141. Confirm persisted Computer settings say `browserMode=shared` and do not contain a managed Human-profile copy/path or CDP endpoint.
142. Run `friday setup computer` again and confirm it reuses the intended Agent desktop indexes rather than adding desktops on every run.
143. Optionally configure `friday setup computer managed-cdp` as a separate fallback test and confirm its isolated service/profile comes from binary-owned assets. Then return the primary candidate to `shared` mode.
144. Confirm Computer configuration is persisted in FRIDAY-owned settings and a directly launched `friday` process sees it immediately without logout/login or manually exporting environment variables.
145. Run `friday doctor` and confirm Computer readiness is reported without pointing the user to source scripts.

**Pass gate:** a normal binary-only user can reach a healthy Computer provider without source/developer commands.

## Stage 12 — Linux Computer real browser behavior

146. Before asking FRIDAY to do anything, open Brave/Chrome normally and keep at least one Human window open on Desktop 1. Log into a disposable test site/account in that normal profile.
147. From Telegram, ask FRIDAY to open a harmless web page using Computer and confirm exactly one appropriate Computer/control approval appears for the logical task.
148. Approve it and confirm a **new** FRIDAY browser window appears on the configured Agent X11 virtual desktop while the original Human window remains open.
149. Confirm FRIDAY restores the Human desktop after creating/activating its Agent window; creating the FRIDAY window must not leave the user forcibly switched away.
150. Confirm the desktop count does not grow every time setup/runtime restarts.
151. In the FRIDAY window, visit the same disposable test site and confirm it already has the normal browser profile's current logged-in session, matching the browser's own **New Window** behavior.
152. Without restarting FRIDAY, log into a second disposable site in a Human window, then have FRIDAY navigate its window there; confirm the current same-profile login is visible without a profile copy/migration step.
153. Navigate to a harmless page and confirm title/structured AT-SPI observation is sufficient for semantic control in shared mode.
154. Click a safe control and confirm it happens exactly once in the FRIDAY-owned window, not in the Human window.
155. Type non-secret text into a safe field, use Enter/Tab/Arrow, and confirm input is targeted only at the FRIDAY-owned window.
156. Trigger a password/OTP/CAPTCHA/protected input and confirm Agent input is refused before dispatch and sensitive field values are not returned in observations/logs.
157. Use Human takeover on the FRIDAY window, enter only disposable/fake test credentials if needed, then hand control back; confirm a fresh observation/generation occurs before further Agent action.
158. End the Computer task and confirm FRIDAY closes only the window carrying its ownership marker. The original Human browser window must remain open and usable.
159. Restart FRIDAY while a Human browser window is open and confirm FRIDAY does not kill/restart the whole Human browser. Start a new Computer task and confirm a new FRIDAY-owned normal-profile window can be created again.
160. Repeat the original Computer task that previously led to repeated approvals and confirm retry of the same admitted turn/job does not generate duplicate routine control approvals.
161. Repeat the original/closest task that previously went silent and confirm the tool-loop ceiling produces a visible bounded result and releases Computer/process resources.
162. If multiple Agent desktops are supported, configure two and run two disposable tasks concurrently; confirm distinct FRIDAY-owned windows/desktops and that unrelated Human windows remain untouched.
163. Restart FRIDAY during a waiting/active Computer Session Job and confirm documented recovery behavior, including safe window ownership cleanup.

**Pass gate:** browser control, profile persistence, approval semantics, takeover safety, cleanup, and restart behavior all work on the real desktop.

## Stage 13 — Scheduling, alerts, conditional hooks, and timezone

164. Confirm the configured IANA timezone is correct.
165. Create a one-shot schedule a few minutes ahead through Telegram.
166. Confirm it fires once at the intended local time and delivers once.
167. Restart FRIDAY before another one-shot schedule fires; confirm it still fires once.
168. Create a short recurring schedule and confirm multiple occurrences keep the intended local wall-clock phase.
169. Cancel/remove the disposable schedule and confirm no further run occurs.
170. Create a disposable alert subscription/condition and trigger it once.
171. Confirm one matching alert is delivered and can be removed.
172. Create a conditional hook with a safe bounded condition/instruction.
173. Trigger it and confirm invocation limits and scope are respected.
174. Remove it and confirm it no longer influences later turns.

**Pass gate:** time/condition-driven work survives restart and does not duplicate delivery.

## Stage 14 — Durable Session Jobs and long-running work

175. Start a task intentionally long enough to become a durable/background Session Job.
176. Confirm Telegram receives the intended acknowledgement instead of waiting silently for the whole job.
177. While it runs, send another independent request and confirm the runtime remains usable according to intended session serialization.
178. List jobs and confirm status/progress metadata is bounded.
179. Redirect a disposable job and confirm the new instruction is applied once.
180. Cancel another disposable job and confirm its run-owned processes/resources are cleaned up.
181. Restart FRIDAY while a resumable job is pending/running.
182. Confirm the job restores from durable state without duplicating already-persisted external work.
183. Confirm final delivery retry does not rerun the completed job body.

**Pass gate:** long-running work is durable, controllable, and does not block the whole ingress channel.

## Stage 15 — Skills, MCP, and integrations

184. List/discover currently available Skills.
185. Install one disposable trusted test Skill through the intended user-facing install path.
186. Invoke it from Telegram and confirm it is selected only when relevant/explicit.
187. Try an intentionally unsafe/rejected Skill package and confirm trust scanning blocks it.
188. Remove/replace the disposable Skill and confirm Agent session context refreshes appropriately.
189. Add one disposable MCP server.
190. Authenticate/login if required through the protected flow.
191. Inspect live tool descriptions/input schemas.
192. Invoke one harmless MCP tool successfully.
193. Disconnect/remove the MCP server and confirm its tools disappear.
194. List integration providers.
195. Connect one disposable integration/account.
196. Perform one harmless permitted read/action.
197. Disconnect it and confirm credentials/connection state are no longer active.

**Pass gate:** extension discovery is live-verified, permission-gated, and removable.

## Stage 16 — Other ingress channels, one by one

Only begin after Telegram and shared runtime behavior are stable. This order minimizes debugging ambiguity by testing the richest remaining transports first.

### Discord

198. Configure Discord from the intended normal-user setup/channel administration path.
199. Pair one exact operator identity.
200. Verify inbound text and outbound reply.
201. Verify native approval buttons: approve, deny, stale callback, and resolved control removal.
202. Verify Discord retrievable attachment intake.
203. Restart FRIDAY and confirm no completed message is replayed.
204. Confirm an untrusted Discord identity cannot gain operator authority.

### Slack

205. Configure Slack Socket Mode/Web API credentials through protected capture.
206. Pair one exact operator identity.
207. Verify inbound text and outbound reply.
208. Verify Block Kit approval behavior.
209. Verify unsupported file retrieval produces the documented safe notice rather than a broken artifact.
210. Restart/reconnect and confirm durable admission prevents duplicate work.

### WhatsApp

211. Provision the WhatsApp bridge through the binary-owned `friday setup whatsapp` / typed setup path; do not run a repository helper manually.
212. Complete the normal QR/account pairing.
213. Pair one exact operator identity.
214. Verify inbound/outbound text.
215. Verify text-code approval/deny behavior.
216. Restart/reconnect and confirm no duplicate work around redelivery.
217. Verify media produces the documented support/unsupported behavior.

### Signal

218. Configure the supported loopback `signal-cli` daemon integration.
219. Pair one exact operator identity.
220. Verify inbound/outbound text.
221. Verify text-code approvals.
222. Restart the Signal transport/runtime and confirm reconnect does not duplicate completed work.
223. Record separately whether normal users still need manual external `signal-cli` provisioning; if yes, decide whether that is an accepted external prerequisite or a setup-automation gap.

### Email

224. Configure disposable IMAP/SMTP account settings and credential through protected capture.
225. Pair/trust the exact expected sender identity.
226. Send one new test email after FRIDAY starts and confirm one reply.
227. Confirm historical mailbox contents are not replayed on first startup.
228. Verify text-code approval behavior.
229. Restart FRIDAY and confirm UID/UIDVALIDITY checkpoint behavior prevents duplicate processing.
230. Confirm the Email threat-model limitation around upstream anti-spoofing remains documented and is not mistaken for cryptographic sender proof inside FRIDAY.

### Microsoft Teams

231. Configure the disposable Teams/Bot Framework credentials/webhook path.
232. Pair one exact operator identity.
233. Verify inbound/outbound text.
234. Verify Adaptive Card approval and text-code fallback.
235. Restart and confirm durable handling/no duplicate completed work.

### Google Chat

236. Configure the disposable Google Chat service-account/webhook settings through the intended setup flow.
237. Pair one exact operator identity.
238. Verify inbound/outbound text.
239. Verify Card approval and text-code fallback.
240. Restart and confirm no duplicate completed work.

### SMS / Twilio

241. Configure disposable Twilio account/from number/webhook settings and protected auth token.
242. Pair one exact operator identity/phone sender.
243. Verify inbound/outbound text.
244. Verify text-code approvals.
245. Restart and confirm webhook/delivery handling does not duplicate completed work.

**Pass gate:** every advertised channel passes its real transport-specific matrix; do not extrapolate Telegram success to another provider.

## Stage 17 — Client Gateway, devices, streaming, and webhooks

246. Start the Client Gateway through the intended product surface.
247. Pair one disposable client/device through the supported pairing flow.
248. Authenticate HTTP and WebSocket requests with the real issued client credential.
249. Verify unauthenticated requests are rejected.
250. Exercise status/profile/conversation/project endpoints with valid and invalid IDs.
251. Exercise Computer gateway endpoints only after the Computer stage passes.
252. Connect two disposable WebSocket clients and verify intended targeted signaling while preventing forged source identity.
253. Test malformed/oversized WebSocket input and confirm bounded error handling.
254. Revoke the disposable device and confirm access stops immediately.
255. Start a disposable webhook route.
256. Send an authenticated valid request and confirm one intended event/action.
257. Send invalid/unauthenticated input and confirm rejection.
258. Stop the webhook route and confirm it no longer accepts traffic.

**Pass gate:** client/device/webhook authority is explicit and revocable.

## Stage 18 — Autonomy, refinement, spending, and self-improvement

259. Set a small disposable spending/budget limit and confirm it is enforced.
260. Clear/restore the limit and confirm normal operation resumes.
261. Run one bounded autonomy task and confirm permissions still apply.
262. Create a refinement plan on disposable state.
263. Apply it only after intended approval.
264. Inspect history.
265. Roll it back and confirm prior state returns.
266. Configure the self-improvement source/candidate boundary in the intended supported way.
267. Run a harmless self-improvement/evaluation candidate in a disposable repository/generation.
268. Confirm verification/evaluation gates must pass before promotion.
269. Confirm a failed candidate is not activated.
270. Promote one passing disposable candidate.
271. Confirm restart/handoff requires the intended authority when other work is active.
272. Confirm the successor takes over, the originating request resumes, and old/new runtimes do not race as two active owners.
273. Exercise rollback/recovery on the disposable candidate.

**Pass gate:** self-modifying behavior remains bounded by explicit source, evaluation, promotion, handoff, and rollback gates.

## Stage 19 — Backup, restore, Vault recovery, crash recovery

274. Stop FRIDAY as required by the backup contract.
275. Create an encrypted full-state backup through `friday backup create --encrypt`.
276. List and verify the backup.
277. Add one disposable piece of state after the backup.
278. Restore the backup into the disposable test environment using the documented confirmation flag.
279. Start FRIDAY and confirm the restored conversations/settings/memory/project state matches the backup point.
280. Create a Vault recovery kit with a strong disposable test passphrase.
281. Test recovery into a disposable Vault state.
282. Confirm the wrong passphrase fails without corrupting the current Vault.
283. Trigger a controlled catchable runtime failure and confirm a redacted crash record is written.
284. Under the supported supervisor mode, confirm FRIDAY restarts within bounded restart policy.
285. Confirm durable sessions/jobs/events recover without duplicate external work.
286. Confirm hard failures that cannot be application-logged are still diagnosable from the host supervisor journal as documented.

**Pass gate:** state and secrets are recoverable without plaintext leakage or duplicate work.

## Stage 20 — Always-on installation and final release soak

287. Install always-on mode with `friday setup service` from the release binary. Do not manually copy `deploy/systemd/friday.service` from a source checkout.
288. Confirm the user service starts FRIDAY with the same persisted workspace/settings as foreground mode.
289. Confirm Computer configuration is also visible to the supervised FRIDAY process when Computer is enabled.
290. Reboot/log out/in according to the supported lifecycle and confirm expected startup behavior.
291. Run a multi-hour soak with Telegram enabled and the other already-passed capabilities available.
292. During soak, exercise a scheduled task, one background Session Job, one memory recall, one attachment, one approval, one Voice STT message, and one Computer task if Computer has passed.
293. Confirm no steadily growing duplicate browser windows/desktops, stuck approvals, orphan processes, retry storms, or silent ingress stalls.
294. Run final `friday doctor`.
295. Review redacted diagnostics/observability and confirm there are no unexplained recurring failures.
296. Create one final encrypted backup.
297. Record the final pass/fail matrix and only change rows in the status table to **VERIFIED** when their corresponding real stage has passed.

**Final release gate:** the normal user can install the binary, provide credentials/account setup, and use every claimed feature without needing FRIDAY's source tree or internal shell scripts.

---

## Evidence template for each real verification

```text
Area / stage:
Date/time:
Commit / binary version:
OS / desktop / architecture:
Channel/client:
Exact user action:
Expected result:
Actual result:
Pass / Fail / Blocked:
Relevant redacted logs/evidence:
Bug/issue link if failed:
```

Never store real API keys, passwords, OTPs, recovery passphrases, private browser cookies, or unredacted sensitive screenshots in verification evidence.
