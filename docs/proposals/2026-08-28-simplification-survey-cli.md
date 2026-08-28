# Simplification survey: CLI TUI, state, and runtime (2026-08-28)

Status: implemented across #11546 (state layer), #11547 (runtime and
commands), and #11548 (panes and rendering), grounded on `origin/main` at
`daa6efd601` and rebased onto `7fd7894d86` (#11544). Companion to
`2026-08-15-single-substrate-hosts-as-renderers.md` — the two host-parity PRs
(#11545 transcript plane; #11550 state plane) moved the CLI onto the shared
session state first; this sweep removed what the CLI kept for itself.

## Scope and method

Three read-only survey agents, one per domain — the TUI state layer
(`packages/cli/src/chat/tui/state/`), the panes and rendering tree
(`packages/cli/src/chat/tui/panes/`, `modals/`, `App.tsx`), and the runtime
and command layer (`packages/cli/src/runtime/`, `commands/`) — followed by one
adversarial verifier per domain that applied every candidate alone in a
throwaway worktree on `origin/main` and ran the CLI typecheck (both
`tsconfig.json` and `tsconfig.scripts.json`), the test-kernel typecheck, and
`vitest src/test-kernel/cli` before returning a measured verdict. The three
implementers then re-ran those gates plus scoped eslint and the dead-code
ratchet. Every count below is the measured `git diff --stat`, not the
survey's estimate.

Gate lesson recorded for the next sweep: the verifiers' gate set missed three
real problems the implementers caught — a consumer in
`packages/cli/scripts/tui-harness.tsx` (typechecked only by
`tsconfig.scripts.json`), a `no-nested-ternary` lint error, and a barrel
re-export orphaned by a deletion (dead-code ratchet). Verify with all three.

Rulings consulted and not re-litigated: the texra-cli skill's rendering
model (Static scrollback owns finalized rows; the live region stays minimal;
resize is a full repaint from a known origin), #11497's `quietLogs` ruling,
#11499's escape-routing collapse, and the anti-over-testing ruling (#10667).

## Defects found by the survey (fixed here)

- **Live scrollback and repaint disagreed on row order** (panes P1).
  `incrementalStaticTranscriptEntries` appended the settled suffix in array
  order while the rebuild oracle `orderedStaticTranscriptEntries` sorted by
  settlement order, so a tool that completed after a self-settling fileList
  row printed `[tool, fileList]` live and `[fileList, tool]` on any repaint
  (resize, owner switch, `/clear`). The old tests never saw it because both
  sides went through the same append helper. The suffix is now sorted with
  the same order key.
- **Two owners of the execution-label repaint** (panes P5): the advance
  path's repaint epoch and a `useMemo` key in `ConversationRegion` both
  triggered the clear-and-reprint. One owner now; the label change bumps the
  epoch inside the existing `layoutChanged` block (an unconditional bump
  double-fired when a label change also trimmed).
- **Hand-cased workspace approval policy fell back to `ask`** (runtime R4):
  `{"texra.approvalPolicy": " Yolo "}` warned and was ignored because the
  top-level field schema had no normalization. One regression test.
- **`texra help --cwd X run` printed root usage** (runtime R7): `help.ts`
  re-implemented command resolution without `reorderGlobalFlags`, so a
  value-taking global flag ahead of the path derailed it. `help` now
  re-enters `runCli`; 25 of 26 bundled variants byte-identical, the 26th is
  the fix.
- **External-inquiry rejection was unowned** (state C5):
  `handleExternalInquiryAction` does file writes and the CLI has no
  `unhandledRejection` handler, so a rejection crashed the process. One
  action value, one owned `.catch` that logs.
- **Two silent catches** (state C6): `approvalQueue.onPresent` swallowed
  anything the presenter threw; the inquiry `'unavailable'` fallback never
  logged its cause. Both now `logWarning` with the cause (+10 LoC, stated as
  a defect fix, not a simplification).
- **Feedback-prompt failure was silently flattened** (runtime R5): an inner
  `catch { feedback = undefined }` (introduced in eaeb43094a without a
  rationale) hid a stdin failure that the outer catch already classifies as
  `'CLI approval prompt failed.'`.

## Landed simplifications (measured)

State layer (#11546, 11 files, +82/−228): `compactionRequest.ts` inlined into
its only caller and its injected-callback test deleted (−104); the per-entry
LRU(4)+labels-token line cache collapsed to a single-slot `WeakMap` memo now
that `transcriptToLines` has one caller at one width (5de190f4a3 removed the
other) (−34); the `ApprovalBypassKind` re-export shim, `formatInteger` →
`toLocaleString('en-US')` (byte-identical on the fixtures), three
zero-consumer type exports, and the orphaned `ManualCompactionRequestResult`
barrel row.

Runtime and commands (#11547, 21 files, +73/−272): `CliExecuteOptions.wrap`
(last producer removed in c9407853f8); the launcher action-hint machinery
(producer removed in 64615c890b; the `tui-harness.tsx` consumer updated; the
unused `actionHintLoginOrKey` copy row); `preflightCliHistoryDeleteAll`
inlined (and `--yes` no longer lists executions only to discard the count);
the redundant second `initCliPlatform` in `selectCliRunModel` (all three
callers init first); `Intl.ListFormat('en')` for the two hand-rolled joiners
(byte-identical for 0–4 items); `configFileExists` → `pathExists` gated on
`ENOENT | ENOTDIR` for the two command callers, so `EACCES`/`EIO` now reach
the command's catch instead of reading as "absent".

Panes and rendering (#11548): `shortcutsActive` deleted — provably
`≡ !childListFocused && !inputActive`; #11499 residue (`runPending` in
`appEscapeInterruptActive`, `triggerAppCtrlC`'s return value,
`visibleApprovalRootStreamId`); `allocateConversationBottomPanelRows`
un-exported; five test-only exports un-exported with their tests retargeted
at the public seam (knip baseline −30); `buildStaticTranscriptItems` builds
from scratch (both callers passed `[]`); `<BoundedTranscriptEntry
maxRows=estimate>` folded into `<TranscriptEntry fillWidth>` after a 54/54
byte-identical Ink render proof; `splitTranscriptEntries.finalized` dropped
(sole caller read `.pending`).

## Refuted or deferred (with the reason)

- **`resolveLocalTranscriptStreamId` inline (state C7-2)** — refuted by the
  implementer: `tui-harness.tsx:2169` is a second consumer with a different
  fallback id; inlining would duplicate the expression.
- **`Object.freeze` on `NO_BYPASS` / `EMPTY_SESSION_META` (state C7-5)** —
  no mutation site exists and the fields are already `readonly`; defensive
  noise, not simplification.
- **`resume.ts` via `defineCliCommand` (runtime R8c)** — not a pure refactor:
  context construction moves ahead of id validation, changing stderr
  precedence in 3 of 9 invalid-id cases for −1 line.
- **`quietLogs` parameter (runtime R9)** — 24 production call sites all pass
  `true`; deleting it changes zero production bytes and ~20 LoC, but two
  tests pin `quietLogs: false` paths that no production path reaches, and
  the `refreshModelListAndLog` failure would become a visibly bare catch.
  #11497's ruling stands; if it is ever deleted, route that error through
  the persistent-config-warning bypass rather than leaving the bare catch.
- **`pathExists` for `resumeExecution.ts`'s input probe (runtime R8b)** —
  scoped out: `EACCES` there only suppresses the interrupted-resume hint;
  turning it into a crash before resume starts is not an acceptable trade.
- **`toolDisplaySpanTextProps`, `slashSubmitText` un-export (panes P8)** —
  retargeting needs an Ink colour render / driving `InputBar`; not cheap.
- **`streamViewForId` double `streamTabInfoFor` (state C7-3)** — the count
  claim was wrong (two calls, not three; the third is the parent lookup);
  net ≈ 0 LoC; deferred to Batch B.
- **Batch B (state C1 `rootRunStartAvailable`, C4 `*ForTest`
  pass-throughs, C7-4 remainder in `sessionRunState.ts`/`streamViews.ts`)** —
  sound, measured (−17, −20, ≈ −10), held because the files overlap the
  state-plane host-parity PR; land after it merges.
- **The `rebuildTree` phase grouping in the CLI dashboard** was measured
  against the board's (65 L nested + orphan re-rooting vs 18 L flat) and left
  host-local by #11545 — extraction net-adds; only the heading copy was
  lifted to `@shared/copy/workflowCall`.
