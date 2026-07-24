# Sharing & consistency: CLI TUI ↔ VS Code extension

> **Status:** Partially landed roadmap (2026-07-04 status sweep). CLI
> approve/reject proposal routing now goes through the shared
> `ProgressAgentProposalController`; setup-action parity and the remaining
> sharing rungs are still open. Produced by an adversarial analysis pass over the
> shared cross-host layer (`src/controllers`, `src/hosts`, `src/shared`) versus
> the CLI TUI state layer (`packages/cli/src/chat/tui/state/`).

## The situation today

The intended host-neutral layer already exists and is VS Code-free:

- `src/controllers/{progressView,settingsView,mainView}` (~2.6k lines)
- `src/shared/settingsView/handlers/*` (~440 lines)
- `src/hosts/*` ports (`promptHost`, `terminalHost`, `diffViewHost`,
  `clipboardHost`, `externalOpener`)

But adoption is lopsided: the **extension consumes `@controllers` (8 imports)**,
while the **CLI consumes it 0 times**. The CLI instead re-implements the same
orchestration in `packages/cli/src/chat/tui/state/` (18 files). `cliState.ts`
states the intent explicitly — it _"mirrors the webview's `progressState`
shape … so future feature parity is a port, not a rewrite."_ That parallelism
is the inconsistency: two implementations of the same orchestration kept in
lockstep by hand, which drifts.

Two concrete drifts already exist:

1. **Approval handling is implemented three times** — extension
   (`ProgressViewMessageHandler`), CLI TUI (`subscribeApprovals.ts`), and CLI
   headless (`approvalAdapter.ts`) — all calling the same
   `@agent/runtime/runCoordinators` + `@tools/{approval,inquiry,userQuestion}`
   functions with _subtly different feedback strings_.
2. **The CLI silently cannot do proposal "setup" actions** that the extension
   supports: the extension routes proposals through
   `ProgressAgentProposalController.handleAction` (which knows `setup` +
   `restoreTaskState`), but the CLI calls `resolveProposal({action})` directly
   and has no notion of `setup`.

## Recommended direction (laddered, low-risk first)

Each rung is independently shippable and behavior-preserving until the last.

### Rung 1 — a canonical `ApprovalDecision` schema (small, low risk)

Add `src/shared/schemas/approvalDecision.ts` (Zod + `z.infer`):
`{ accepted, feedback?, userQuestionAnswers?, bypass?, apiMode? }`. Re-derive
the two existing CLI decision shapes from it (TUI =
`packages/cli/src/chat/tui/state/approvalQueue.ts`; headless =
`approvalAdapter.ts` via `.pick({ accepted, userMessage })`). No runtime change
— this just gives later work one decision vocabulary.

### Rung 2 — share the auto-decision policy ladder (small, low risk)

Move `denyMessage` + the per-kind yolo/deny feedback strings (currently
copy-pasted between `approvalAdapter.ts` and `subscribeApprovals.ts`) into a
shared `src/controllers/approval/approvalPolicy.ts`. Both CLI paths import it;
CLI-only wiring (`enqueueCliPrompt`) stays in the CLI.

### Rung 3 — route proposals through the existing controller (medium)

Wire a `ProgressAgentProposalController` in the CLI with CLI deps
(`resolveProposal` from `runCoordinators`, `restoreTaskState` → `false`
initially) and replace `subscribeApprovals.dispatchProposal`'s direct
`resolveProposal` call with `controller.handleAction(...)`. This reuses an
already-shared controller and is the first step toward closing the setup-action
drift — no new abstraction.

### Rung 4 — one host-neutral approval dispatcher (medium)

With rungs 1–3 in place, add `src/controllers/approval/ApprovalDecisionDispatcher.ts`
taking a normalized `ApprovalDecision` + event payload and performing the
coordinator/tool dispatch. All three hosts then only _collect_ the decision
(modal / stderr prompt / webview message) and call the one dispatcher — the
three divergent accept→approve / reject+feedback copies collapse to one.

## Adjacent shared-state wins (independent of approvals)

- **Terminal-status predicate** (small): CLI's `FINAL_TRANSCRIPT_STATUSES` /
  `isFinalTranscriptStatus` (`transcript.ts`) duplicates a concept that belongs
  next to `LIVE_ELAPSED_STREAM_STATUSES` in the shared stream schema. Add
  `TERMINAL_STREAM_STATUSES` + `isTerminalStreamStatus()` there and delegate.
- **Child-stream selectors** (small): move `mergeChildStreams` +
  `visibleSubagentRows` (`childExecutions.ts`) and `childElapsed` /
  `hasLiveChildElapsed` (`childControls.ts`) into
  `src/shared/selectors/` (they depend only on `ActiveChildInfo`), leaving thin
  re-exports so CLI call sites/tests are untouched; the webview adopts them in a
  follow-up. This is where the CLI could _gain_ the webview's finished-child
  counts and stop drifting on badge logic.
- **CLI host shims** (medium): implement `packages/cli/src/hosts/CliPromptHost.ts`
  against the existing `PromptHost` port (only `confirm`/`warning` are needed by
  `SettingsMemoryController`). That unlocks CLI reuse of the host-neutral
  Settings controllers without touching controller code, validated by the
  existing `src/test-kernel/hosts` FakeHosts invariants.

## Principle

Treat `src/controllers` + `src/hosts` as the single home for view-orchestration
logic, and the CLI `state/` layer as _host wiring_ (Ink signals + keystrokes)
that consumes it via injected ports — mirroring how the extension consumes it
via webview messages. New view behavior should land in a controller once, with
both hosts adopting it, rather than being added to the webview and ported to the
TUI by hand.
