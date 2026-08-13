---
created: 2026-08-03
updated: 2026-08-03
---

# PRD: Unified approval policy across CLI, desktop, and extension

**Status:** Draft (v1.1 — every factual claim re-verified against main @ `363e2941d4`, 2026-08-03)
**Owner:** TBD
**Date:** 2026-08-03
**Tracking issue:** [#9597](https://github.com/LionSR/TeXRA/issues/9597)
**Branch:** `claude/texra-9597-design-review-5tyyls`
**Prior stages (merged):** #9610, #9673, #9687, #9689, #9692

## 1. Summary

TeXRA has one host-neutral approval-policy authority — the `never | ask | yolo`
vocabulary, copy, parser, and pure `allow | deny | present` evaluator in
`src/shared/approvalPolicy.ts`, with the live value owned by
`SessionHandle` and enforced at the shared Bash/tool-edit request boundaries
in `src/tools/approval/`. Today only the CLI uses it. The extension and
desktop hosts never call `setApprovalPolicy`, so both run permanently on the
`'ask'` default, and the CLI still carries a residual decision layer
(~90 lines) that mirrors, wraps, or forks the shared authority.

This PRD finishes the migration in five bounded stages:

- **A** — make the evaluator's `deny` carry its reason, so denial messages
  stop conflating "policy forbids" with "nothing can present a prompt", and
  fix the shared module's own internal tuple duplication.
- **B** — delete the CLI decision mirror. The two remaining policy rules that
  exist only as CLI code (yolo denies retries; yolo cannot synthesize a
  human answer) hoist into the shared authority as pure helpers.
- **C** — seed and update the extension and desktop policy from the one
  canonical persisted spelling, add the native settings control and
  effective-status display, using only presentation code in the hosts.
- **D** — vocabulary hygiene: delete dead `superYolo` state, deduplicate the
  bypass-kind union, rename misnamed internal identifiers while pinning
  every shipped wire literal.
- **E** — a structural retirement gate that makes a second policy
  parser/evaluator/enforcement mirror a CI failure.

Each stage nets negative or neutral module/branch count. The deletion ledger
is §9; the acceptance criteria restate #9597's proof obligations as testable
checks.

## 2. Product decisions (unchanged from #9597)

These are inherited, not re-litigated here:

1. **Yolo is real yolo.** No TeX or file-edit carve-out. The earlier
   LaTeX-exception proposal is superseded (owner decision, 2026-08-02).
2. **Mixed mode is a first-class `ask` configuration**: Bash automatic while
   edits still require approval (and vice versa), via the two independent
   `texra.toolUse.requireBashApproval` / `requireEditApproval` settings.
   This must never be encoded as `yolo`.
3. **`never` wins** over prompt-disable settings and scoped bypasses.
4. **Headless `ask` settles deterministically** — deny, never park.
5. **Scoped bypasses are separate facts**, per stream and per kind.
6. **Provider-native modes pass through unchanged.** Codex
   (`never | on-request | untrusted | on-failure`) and Claude
   (`default | acceptEdits | bypassPermissions | plan`) are distinct
   vocabularies; no cast or inference to/from TeXRA policy. Verified: no
   conversion or cast exists today.
7. **No policy resolver, registry, host facade, or second persisted
   spelling.**
8. **Request-time policy capture** for in-flight requests when policy
   changes, unless a later focused design proves cancellation simpler.

## 3. Decision matrix (completed)

The #9597 matrix covers Bash and tool edits. The running system has three
more request kinds whose policy behavior currently exists only as CLI code.
This PRD promotes them to spec:

| Request kind                                  | `never` | `ask`                                         | `yolo`                                                                                                                                              |
| --------------------------------------------- | ------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bash                                          | deny    | present iff `requireBashApproval`, else allow | allow                                                                                                                                               |
| Tool edit                                     | deny    | present iff `requireEditApproval`, else allow | allow                                                                                                                                               |
| Plan approval / agent proposal                | deny    | present (deny if unpresentable)               | allow                                                                                                                                               |
| Retry request                                 | deny    | present (deny if unpresentable)               | **deny** — automatic attempts are exhausted; continuing requires explicit human approval. Not classified as a policy denial for exit-code purposes. |
| Retry after credential exhaustion / 401 / 403 | deny    | present (deny if unpresentable)               | deny ("credential exhausted or unauthorized")                                                                                                       |
| User question / external inquiry              | deny    | present (deny if unpresentable)               | **deny** — yolo approves execution; it must not invent human intent or synthesize an answer.                                                        |

Additional rows preserved as-is: `approve_and_goal` is produced only by an
explicit user action; Run as Goal grants Bash-only scoped permission and
never edit permission.

**Deny reasons are part of the contract.** `deny` is not one outcome. The
evaluator distinguishes:

- `deny-policy` — the policy forbids the action (`never`).
- `deny-unpresentable` — the policy would present, but the run cannot
  prompt (headless `ask`).

Each reason has its own user-facing message. Today both cases emit
`'Denied by TeXRA approval policy.'` (constant at
`src/shared/approvalPolicy.ts:7-8`, emitted at the shared boundaries
`src/tools/approval/toolEditApproval.ts:264-270` and `bashApproval.ts:111-117`),
which is false in the unpresentable case and sends users hunting for a
`never` setting they did not set.

## 4. The canonical persisted spelling

**`texra.approvalPolicy` in `.texra/config.json` is the single persisted
spelling, for all three hosts.**

This is not new storage: the CLI already writes it (`texra init`,
`packages/cli/src/runtime/initConfig.ts`) and reads it
(`packages/cli/src/runtime/cliConfig.ts`), and the extension already opens
the same file through `ExtensionTexraConfig`
(`packages/extension/src/frontend/vscode/texraConfig.ts`). The extension
declares no `contributes.configuration`; TeXRA owns its own JSON config.
Stage C hoists the key declaration from the CLI-local schema into the shared
settings catalog and adds nothing else.

Explicitly rejected alternatives:

- A `WorkspaceStateKey` entry — would be a second spelling; none exists
  today and none may be added.
- A VS Code `contributes.configuration` setting — TeXRA settings do not
  live there.

Resolution precedence (CLI, unchanged): `--approval-policy` flag >
`TEXRA_APPROVAL_POLICY` env > config file > default (`never` under
`--no-input`, else `ask`). Hosts read the config file only.

The live value remains an in-memory session primitive
(`SessionHandle.approvalPolicy` / `setApprovalPolicy`) seeded from the
persisted spelling at composition time. It is not itself persisted on the
session.

## 5. Current state (verified inventory)

Line numbers and symbols below were re-verified against main @ `363e2941d4`
(2026-08-03): every citation holds unless a correction is marked inline. The
merged-PR ledger (#9610, #9673, #9687, #9689, #9692) is confirmed landed; the
CLI mirror's deletable spans sum to ≈87 lines, matching the "~90 lines"
estimate. No open PR touches this baseline.

### 5.1 What is done and correct

- Shared vocabulary, copy, parser, evaluator: `src/shared/approvalPolicy.ts`.
- Live value on `SessionHandle` (`src/agent/runtime/SessionHandle.ts:269-275`);
  CLI seeds it (`runExecution.ts:189`, `runChatTui.tsx:271`) and `/approval`
  - `/yolo` update it live.
- Enforcement at the shared boundaries only:
  `src/tools/approval/bashApproval.ts:103-117`,
  `toolEditApproval.ts:257-270`. The consumer map in
  `src/shared/schemas/coreSettings.ts:557-558` pins the two prompt-setting
  consumers.
- Extension and desktop host interactions are presentation-only
  (`src/controllers/progressView/backend/progressHostInteractions.ts`);
  an exhaustive sweep found **zero** host-side enforcement branches.
- Denial classification propagates as a run-owned fact through fresh,
  resumed, delegated, and workflow-script execution
  (`RunContext.onApprovalPolicyDenial`, #9692).

### 5.2 What is not done (the gap this PRD closes)

- **Hosts run on the default forever.** No `setApprovalPolicy` caller exists
  outside `packages/cli` and tests.
- **CLI decision mirror.** `packages/cli/src/runtime/approval/approvalPolicy.ts`
  still contains: a wrapper evaluator (`cliExecutableApprovalDecision:118`)
  and four public predicates over it; a second denial-message vocabulary
  (`denyMessage:62`); the yolo-retry rule (`:237-244`); the
  credential-retry rule (`:213-222`); the human-input denial helpers
  (`:290-316`); and a `WeakSet<CliContext>` denial marker (`:59,68-74`)
  whose object-identity keying is a latent exit-code-4 bug (the TUI mints a
  fresh context literal per run; it works only because one object happens to
  be threaded end-to-end).
- **Second parser.** `cliContext.ts:429-438` resolves flag/env/config
  precedence via `pickEnum` (`:306-320`), whose `allowed.includes(candidate)`
  check validates without normalizing through `parseTexraApprovalPolicy`
  (no trim/lowercase), plus a bare `'never'`/`'ask'` fallback literal at
  `:407`.
- **Internal duplication in the shared module itself.**
  `TEXRA_APPROVAL_POLICIES` and `TEXRA_APPROVAL_POLICY_DISPLAY_ORDER` are
  two independent literal tuples; nothing asserts they are permutations.
- **`superYolo` vocabulary sprawl.** Four distinct things share the name:
  (a) the delegated-work scoped bypass kind (real, stays);
  (b) progress-view IPC toggle commands (wire-pinned, stay);
  (c) `UPDATE_SUPER_YOLO_ENABLED`, a reliability/orchestration settings
  message that has nothing to do with yolo (misnomer; internal identifiers
  renameable, wire literal pinned);
  (d) `WorkspaceStateKey.SUPER_YOLO_ENABLED` = `'texra.superYoloEnabled'` —
  dead persisted state with zero readers and zero writers.
- **Duplicated bypass union.** `ApprovalBypassKind`
  (`src/agent/runtime/HostInteractions.ts:226`) and `BypassTypeSchema`
  (`src/shared/schemas/progressView/outbound.ts:235`) are two independent
  copies of `'bash' | 'toolEdit' | 'superYolo'`.

## 6. Non-goals

- No change to the per-stream scoped-bypass machinery
  (`streamApprovalQueue.ts`), its ancestry inheritance, or its
  dispatch-time re-check. The `'proposal'` ancestry key vs `'superYolo'`
  host-facing label split is intentional and documented, not fixed.
- No rename of any shipped wire literal, NDJSON event name, DOM id used by
  the shipped webview, persisted stream-state field, or workspace-state key
  string (except deleting the dead one). Compatibility-pinned literals:
  `ipc.ts:203,204,380`, `'approveSuperYolo'`,
  `'updateSuperYoloBypassState'`, the serialized bypass enum values,
  `streamState.ts:181`.
- No change to Codex/Claude provider-native permission plumbing.
- No cross-host cancellation/republication of pending requests on policy
  change (request-time capture stands).
- No new abstraction: no policy service, no observer registry, no host
  facade port. Seeding is `read setting → setApprovalPolicy`, nothing more.

## 7. Design

### 7.1 Stage A — honest deny + shared-module hygiene

`decideTexraApproval` returns
`'allow' | 'present' | 'deny-policy' | 'deny-unpresentable'`.
Precedence is unchanged: `never` → `deny-policy`; then
yolo/bypass/prompt-disabled → `allow`; then `canPresent ? 'present' :
'deny-unpresentable'`. Callers that only branch on deny match the prefix.

Message constants: `TEXRA_APPROVAL_POLICY_DENIED_MESSAGE` keeps its meaning
(policy denial); a new `TEXRA_APPROVAL_UNPRESENTABLE_MESSAGE` covers the
headless-`ask` case. Both shared boundaries emit the message matching the
reason. The CLI's `denyMessage` fork is deleted — its TTY wording folds into
the shared unpresentable message.

`TEXRA_APPROVAL_POLICY_DISPLAY_ORDER` becomes type- and test-constrained to
be a permutation of `TEXRA_APPROVAL_POLICIES`.

### 7.2 Stage B — one authority, zero mirrors

Two pure helpers move the last host-resident policy rules into
`src/shared/approvalPolicy.ts`:

```ts
decideRetryApproval(input: {
  policy; canPresent; isCredentialFailure: boolean;
}): 'present' | { deny: 'yolo-retry' | 'credential' | 'policy' | 'unpresentable' }

decideHumanInputRequest(input: { policy; canPresent }):
  'present' | { deny: 'yolo-no-human' | 'policy' | 'unpresentable' }
```

(Exact shapes may be tuned at implementation time; the requirement is that
the yolo-retry, credential-retry, and no-synthesized-answer rules live
beside the evaluator with their copy, so a future desktop/extension retry or
question surface calls them instead of re-implementing.)

The CLI then consumes shared decisions directly:

- `approvalAdapter.ts` (headless) and `subscribeApprovals.ts` (TUI) call
  `decideTexraApproval` / `decideRetryApproval` / `decideHumanInputRequest`
  with `policy: session.approvalPolicy` — not a context copy.
- Presentability collapses to `context.mode !== 'interactive'`; the
  policy-parameterized `approvalPromptAllowed` / `approvalPromptsUnavailable`
  predicates are deleted (the evaluator short-circuits `never`/`yolo`
  before consulting `canPresent`, so their policy dependence was dead
  weight).
- Denial stops being run state at all. Exit code 4 (`CliExitCode.ApprovalDenied`)
  is retired along with the `approvalDenied` context flag, its
  `hasCliApprovalDenied` reader, and the exit-code branch that consumed them. A
  denied gate returns feedback to the model, which routes around it, so it is
  not a run outcome and must not colour the exit code: #9692 briefly hoisted the
  denial check above the outcome, which made every `--approval-policy never` run
  exit 4 and silently discarded results in callers that read a nonzero exit as
  "no result". What survives is `warnApprovalDenied`, which writes one
  `[warn] [cli-approval]` line per run to stderr so an operator can still see
  that policy closed a gate.
- `CliContext.approvalPolicy` reverts to a plain pre-session seed. The TUI
  live-alias getter (`runChatTui.tsx:342-344`, inside the per-run
  `currentSessionContext` literal at `:339-347`) is deleted; the genuinely
  pre-session readers (`multiAgent.ts`, `orchestrate.ts`,
  `runInstructions.ts`, `resumeExecution.ts`, init wizard) keep reading the
  seed.
- `cliContext.ts` normalizes every candidate through
  `parseTexraApprovalPolicy` and uses the exported default constants; the
  precedence logic (`pickEnum`) stays — precedence is not parsing.
- What remains of `packages/cli/src/runtime/approval/approvalPolicy.ts`
  (prompt queue, y/N parsing, retry-hint copy) moves to
  `approvalPrompts.ts`; the old module is deleted, no re-export shim.

### 7.3 Stage C — host adoption

**Seeding (extension):** one line after `initializeDefaultSession()` in
`packages/extension/src/extension.ts` (~:263-267), before
`registerAgentFeatures()`.

**Seeding (desktop):** one line after the `SessionHandle` construction in
`packages/desktop/src/main/index.ts` (~:1167). Desktop has no in-process
workspace transition — changing workspace relaunches the app — so startup
seeding is complete coverage.

**Live update:** the settings write paths re-seed —
`SettingsViewMessageHandler.updateStateSetting` (extension) and the
`desktopSettingsIpc` write handler (desktop; widen its
`Pick<SessionHandle,'events'>` session port to include `setApprovalPolicy`
— widen the Pick, do not add a `Platform` port).

**Workspace transition (extension only):** one re-seed line inside the
existing `afterStorageCommit` hook
(`packages/extension/src/frontend/vscode/texraConfig.ts:134-140`), after the
new workspace's config store swaps in. The policy is **not** a transactional
participant: rollback restores the previous config store and the session
value was never touched, so the proof obligation (no stale effective policy
after commit or rollback) is satisfied by ordering alone. If the
implementation finds itself adding hooks, generations, or rollback handlers
for the policy value, it has left the design.

**Settings catalog + UI:** one row in
`src/shared/schemas/stateSettings.ts` (key `texra.approvalPolicy`, schema
`TexraApprovalPolicySchema`, `store: 'config'`,
`settingsViewSnapshot: 'approval'`, hosts `['vscode','desktop']`); the
`approvalPolicy` field added to `buildApprovalSettingsMessage`
(`src/shared/settingsView/handlers/approvalHandlers.ts`) and the
`UPDATE_APPROVAL_SETTINGS` payload schema; a select in the existing
"Approval & safety" section of
`packages/extension/src/settingsView/frontend/tabs/ToolsTab.ts`, options
sourced from `TEXRA_APPROVAL_POLICY_OPTIONS` — no local labels. The desktop
renderer aliases the same Lit components and gets the control for free.

**Mixed-mode explicitness:** the two existing prompt toggles are labeled as
`ask`-scoped ("Under Ask: require approval for shell commands / for file
edits"), making "Bash automatic, edits gated" a visible first-class
configuration and making it obvious the toggles are inert under `yolo` and
`never`.

**Effective-status display:** a policy line in the extension's existing
`texra.taskStatus` status-bar tooltip (it already resolves
`defaultSession()`), and the shared settings surface on desktop. House
rule inherited from the CLI status bar: **policy and scoped bypasses render
as two separate lines** — a session policy is never blended with a
per-stream grant in one indicator.

**Presentation differences stay labeled:** CLI approves the proposal as
written; desktop/extension may edit in the staged diff surface before
acceptance. Shared copy states this; shared semantics do not imply
identical interface capabilities.

### 7.4 Stage D — vocabulary hygiene

- Delete `WorkspaceStateKey.SUPER_YOLO_ENABLED` and its
  `WORKTREE_SHARED_KEYS` entry (`stateManager.ts:18`) — dead state, zero
  readers/writers.
- Deduplicate the bypass union: one shared const tuple; `ApprovalBypassKind`
  and `BypassTypeSchema` both derive from it. Serialized values unchanged.
- Rename internal-only identifiers of the reliability/orchestration settings
  message (`superYoloHandlers.ts`, `buildSuperYoloMessage`,
  `sendSuperYoloEnabled`, `postSuperYoloEnabled`) to their real payload
  name. The wire literal `updateSuperYoloEnabled` stays, per the existing
  compatibility comment in `settingsView/data.ts`.
- Update #9597 with the scoping note: `superYolo` is the delegated-work
  scoped bypass, not a policy value; the `'proposal'`-vs-`'superYolo'`
  key/label split in `streamApprovalQueue.ts` is intentional.

### 7.5 Stage E — structural gate

`src/test-kernel/architecture/approvalPolicyAuthorityRatchet.vitest.ts`,
cloned from the retirement-gate style
(`sessionFactAmbientHelperRetirement.vitest.ts`): hardcoded allowlists, no
baseline JSON — the correct baseline for "second evaluator" is empty, not
"current debt frozen". Runs in CI as an ordinary kernel test; zero CI
wiring.

Assertions:

1. **One vocabulary definition.** Only `src/shared/approvalPolicy.ts` may
   define an enum/tuple over the three policy values. Scoped by symbol, not
   bare string — `CodexApprovalPolicySchema` legitimately contains
   `'never'`, `ExternalInquiryTool` contains `'ask'`; a naive grep gate
   would false-positive and get deleted within a month.
2. **Evaluator call sites == allowlist**: the two `src/tools/approval/*`
   boundaries, the CLI adapter files, and any host retry/question surface
   added later — each addition is a reviewed allowlist edit in the same PR.
3. **Seed sites == allowlist**: the two CLI seeds, `/approval` handler, the
   two host seeds, the transition re-seed, harness, tests.
4. **Vacuity guard**: the scan must have visited >100 files, so a broken
   glob cannot pass silently.

Failure messages follow house convention: name the offending file and say
"if intentional, extend the allowlist in this PR". Doc lists in `CLAUDE.md`
and `AGENTS.md` gain the ratchet; cited paths must resolve
(`check-guidance-refs.mjs` runs ungated).

## 8. Rollout and dependencies

Order is load-bearing:

| Stage | Depends on        | Why the order                                                                                  |
| ----- | ----------------- | ---------------------------------------------------------------------------------------------- |
| A     | —                 | Deny reasons must exist before hosts adopt, or three hosts' messages churn twice.              |
| B     | A                 | The hoisted helpers return reasoned denials.                                                   |
| C     | A (B recommended) | Hosts consume the honest evaluator; C must add zero decision code.                             |
| D     | —                 | Independent; any time before E.                                                                |
| E     | A–D               | The allowlist freezes the final state. Landing it earlier would enshrine the intermediate one. |

Every stage: `npm run typecheck` (builds do not type check),
`npm run lint`, `npm test` for the touched kernels,
`npm run check:dead-code-ratchet`.

## 9. Deletion ledger

The migration is complete only if all of these are gone. This list is also
the negative space of the Stage E allowlist: nothing below may appear in it.

| #   | Deletion                                                                                                                         | Location                                                                                         | Stage |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----- |
| 1   | `denyMessage` — second denial-message vocabulary                                                                                 | `packages/cli/src/runtime/approval/approvalPolicy.ts:62-66`                                      | A     |
| 2   | `cliExecutableApprovalDecision` wrapper evaluator                                                                                | same file `:118-125`                                                                             | B     |
| 3   | `approvalPromptAllowed` / `approvalPromptsUnavailable` policy predicates                                                         | `:106-114`                                                                                       | B     |
| 4   | `immediateDecision` / `immediateDecisionForApproval`                                                                             | `:199-245`                                                                                       | B     |
| 5   | `isCredentialRetryRequest` + yolo-retry branch (hoisted to shared)                                                               | `:213-244`                                                                                       | B     |
| 6   | `humanInputDenialFeedback` / `askUserQuestionDenial` (hoisted to shared)                                                         | `:290-316`                                                                                       | B     |
| 7   | `approvalDenied` context flag (`markApprovalDenied` / `hasCliApprovalDenied`) and the `CliExitCode.ApprovalDenied` branch it fed | `cliContext.ts`, `approvalPrompts.ts`                                                            | B     |
| 8   | `ApprovalInstructionContext` pick type                                                                                           | `:54-57`                                                                                         | B     |
| 9   | The module `runtime/approval/approvalPolicy.ts` itself (survivors move to `approvalPrompts.ts`; no re-export shim)               | whole file                                                                                       | B     |
| 10  | TUI live-alias `get approvalPolicy()` on the per-run context                                                                     | `packages/cli/src/chat/tui/runChatTui.tsx:342-344`                                               | B     |
| 11  | Bare `'never'`/`'ask'` fallback literals and unnormalized env parsing                                                            | `packages/cli/src/runtime/cliContext.ts:407, 429-438`                                            | B     |
| 12  | CLI-local declaration of the `approvalPolicy` settings key (hoisted to shared catalog)                                           | `packages/cli/src/schemas/cliSettings.ts:26`                                                     | C     |
| 13  | `WorkspaceStateKey.SUPER_YOLO_ENABLED` + `WORKTREE_SHARED_KEYS` entry                                                            | `src/shared/state/stateKeys.ts:22`, `packages/extension/src/common/state/stateManager.ts:18`     | D     |
| 14  | One of two copies of the bypass-kind union                                                                                       | `src/shared/schemas/progressView/outbound.ts:235` vs `src/agent/runtime/HostInteractions.ts:226` | D     |
| 15  | `superYolo`-named internal identifiers on the reliability/orchestration message                                                  | `src/shared/settingsView/handlers/superYoloHandlers.ts` and its two host callers                 | D     |

Explicitly **kept**: all pinned wire literals (§6); the per-stream bypass
machinery; `proposalFlow.ts:147` (a comment, not logic); both
provider-native vocabularies; the CLI prompt queue and y/N parsing; the CLI
status-bar short labels (`statusBarDisplay.ts:771-792` — deliberate terse
display copy, exhaustively switched, not a decision fork).

## 10. Acceptance criteria (proof obligations, testable form)

1. `never` denies Bash and edits even with both prompt settings disabled and
   a scoped bypass active (truth-table rows exist).
2. `ask` supports all four combinations of automatic/manual Bash and edits.
3. `yolo` allows Bash and edits with no presentation.
4. A headless `ask` denial reports the unpresentable message, not the
   policy-denial message; a `never` denial reports the policy message.
   No caller can conflate them (the type forces the distinction).
5. Retry under `yolo` denies with the exhausted-attempts message on every
   host that surfaces retries; the rule has exactly one definition, in
   `src/shared/approvalPolicy.ts`.
6. User questions and external inquiries are denied under `yolo` with the
   no-synthesized-answer message; one definition, shared.
7. No-input paths settle deterministically, and no denial path changes the
   process exit code on either the headless or the TUI side: a denied gate
   yields model feedback plus one stderr warn, and the run exits on its own
   outcome alone.
8. Scoped grants never cross permission kinds or streams (existing tests
   remain green; no changes to `streamApprovalQueue`).
9. Goal lifecycle keeps the Bash-only grant (existing tests).
10. No cast or inference between TeXRA policy and Codex/Claude modes
    (ratchet assertion 1 + review).
11. Extension and desktop sessions reflect `.texra/config.json`'s
    `texra.approvalPolicy` at startup, after a settings write, and (extension)
    after a workspace transition commit; rollback leaves the previous
    effective policy. New kernel test for the transition case.
12. The same request produces the same decision input on all three hosts:
    hosts contain zero evaluator calls (ratchet assertion 2 restricts call
    sites to shared boundaries + CLI adapters).
13. Every row of §9 is deleted; the Stage E allowlist contains none of them;
    total modules and branches are fewer than at the start (diff stat +
    knip ratchet).

## 11. Risks

- **Exit-code-4 regression while replacing the WeakSet.** Mitigation:
  pin both denial paths with tests _before_ the swap (§10.7).
- **Message-text churn breaking snapshot tests.** Stage A lands the final
  strings once; B and C reuse them; hosts adopt after.
- **Ratchet false positives** on `'never'`/`'ask'` literals in unrelated
  vocabularies. Mitigation: symbol-scoped scanning (§7.5.1) plus the
  vacuity guard.
- **Scope creep in Stage C** toward a policy service or event fan-out.
  Mitigation: the non-goal is explicit (§6); review gate is "C adds zero
  decision code to hosts".
- **Stale-policy edge on workspace transition** if the re-seed lands outside
  `afterStorageCommit`. Mitigation: the dedicated kernel test (§10.11).

## 12. Completion condition

Matches #9597, sharpened: all three hosts seed and update the same live
`SessionHandle` authority from the single persisted spelling; the mixed
Bash/edit mode is visible and labeled in the shared settings UI; `yolo`
requires no edit approval; every entry in the §9 deletion ledger is gone;
and `approvalPolicyAuthorityRatchet` is green with its minimal allowlist.
