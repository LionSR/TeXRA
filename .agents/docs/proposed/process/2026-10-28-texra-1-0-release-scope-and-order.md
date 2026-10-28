---
created: 2026-10-28
status: proposed
---

# TeXRA 1.0: release scope, the pre-freeze set, and the order of work

Baseline: `main` at `8fcd0a3` (2026-10-28). Line references point into that
tree. The tracker is [#13736](https://github.com/LionSR/TeXRA/issues/13736);
this note is the plan it lacks: what 1.0 is, what must land before the
storage freeze, what explicitly waits, and the order.

## Problem

The last release is 0.40.10 (2026-09-06). `CHANGELOG.md` holds 349 unreleased
entries, six of them breaking. October's commits are 18 `refactor`, 9 `chore`,
7 `docs`, 5 `test`, 3 `fix`, 2 `feat`. #13736 has 27 of 34 sub-items done, yet
the two newest design notes
([general package](../architecture/2026-10-21-harness-general-package-design.md),
[tech-debt targets](../architecture/2026-10-27-tech-debt-target-designs.md))
together open nine lanes, about thirty slices and fourteen owner decisions.
Each audit has produced more work than it closed.

Two products with different readiness share one release definition. The app
(extension, desktop, CLI) is close: its storage layer, agent model and host
boundary are done. The harness as a general package is open-ended by nature,
and it is allowed to break at 0.x. Tying the first to the second is what keeps
1.0 from shipping.

The 10-21 design is also stale in the repo's favour, which hides how close the
app is:

- the root entry has 48 exports, not 246 (`config/api-reports/harness.api.md`,
  #14337);
- `config/ratchets/harness-deep-import-baseline.json` lists one specifier,
  `@eventBus/AppSignals`, for four packages;
- 90 of the 92 files in `packages/texra/src/tools` import only public entries;
- `run.start` v2 with `parent.call` landed (#14335), goal mode is a script
  (#14201), the golden store generates the same output twice (#14260 closed).

## Decision: what 1.0 is

**TeXRA 1.0 is the app release with a frozen storage format.** It ships the
extension, the desktop app and the CLI from one tagged commit, after
`npm run storage:freeze` (the `releasing` skill, step 1). `@texra-ai/harness`
and `@texra-ai/llm` stay 0.x and publish on their own schedule; their public
surface is not a 1.0 gate. The rulings ledger already says both are releasable
at 0.x (D11, as amended 2026-10-06).

What this means for the open design work:

- A change that alters stored bytes lands before the freeze or pays for an
  upcaster forever. That is the only hard gate.
- A refactor that leaves rows unchanged is not a 1.0 item, however large its
  design note. The run-lifecycle, host and storage-reader slices (L1 to L5,
  H1 to H4, S3 to S6) are all in this class and wait.
- Naming. The app keeps the TeXRA name: the Marketplace id, the `texra` CLI,
  the `texra.*` setting keys and the `.texra/` directories are user-facing
  and become permanent at the freeze. The harness's npm name is decided before
  its first publish, not before 1.0. The one preparation worth doing before
  the freeze is passing the setting namespace into the catalog as data
  (`packages/harness/src/shared/state/stateSettings.ts`), with stored keys
  unchanged, so renaming the harness later touches no stored byte.

## Goals

1. Ship `1.0.0-preview.1`, then `1.0.0`, from `main`, with frozen stored
   shapes that every later build reads through upcasters.
2. Every stored shape that is known to be wrong is fixed before the freeze.
3. Nothing lands before the freeze that does not change stored bytes or the
   freeze mechanism, apart from copy fixes and the release notes.

## Non-goals (explicitly deferred past 1.0)

- Lanes 1 to 9 of the general-package design, except the two items named in
  P6 below.
- The run-lifecycle redesign (L1 to L5 of the tech-debt note; L5 is pulled
  forward in P2 because goal delivery depends on it), the host dedup
  (H1 to H4), and storage readers S3 to S6, including the SQL `runs` view
  rewrite (`packages/harness/src/agent/runtime/historyQuery/views.ts`).
- The `HistoryQuery` child-process protocol cleanup
  (`packages/harness/src/agent/runtime/historyQuery/HistoryQuery.ts`).
- Lifting the script door out of `dispatchPendingResponse`, the typed
  per-script services that replace its shared-value map, and the durable
  launch cap (`packages/harness/src/tools/delegation/agentChild.ts`).
- The three runtime performance readings (#12076) and any `Metric`.
- test-kernel deep imports (178 of 275 suites); the plugin-author subset of
  `./host`; pruning general helpers from `./plugins`. The last two precede
  the first npm publish, not 1.0.
- The `codecVersion` read rule: `packages/harness/src/agent/runtime/storedTurn.ts`
  decodes live payloads with llm's `Literal(1)`, so a move to codec 2 must
  change the reader first. It changes no stored byte, so it is not
  freeze-gated; it is gated on llm's codec bump.
- The UX roadmap items.

## Evidence per area

Five read-only audits of the tree on 2026-10-28, each checked against the
code before it was used here.

**Effect-native.** The harness holds no Promise orchestration: over 87k lines,
`new Promise` 0, `.then` 1 (the sandbox prelude), `Effect.run*` 0 outside the
worker entry, every `async` a comment or the guest-script boundary. What
remains is structural: one `AbortController` and about ten mutable fields in
`packages/harness/src/agent/runtime/childRunLoop.ts` (D1 of the tech-debt
note), hand-built `Map<seq, Deferred>` ordering gates in
`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`, and the
`HistoryQuery` class. None of it changes a row. Verdict: sufficient for 1.0.

**Codemode.** The design holds. Two things touch the freeze:

- `script.call` v1 (`packages/harness/src/shared/schemas/runHistoryEvent.ts`)
  stores `callId` and `stageId`, both derivable from the script call id and
  the sequence number. A row restates a fact. Drop them or keep them, now.
- Live result delivery to the guest follows `Queue.offer` order
  (`packages/harness/src/agent/codeSandbox/codeSandbox.ts`, the `settled`
  queue), while replay follows commit order (`toolUseDispatch.ts`,
  `replayOrder`). They agree today by scheduling, not by construction; an
  order-sensitive script could fail with `ScriptDiverged` on resume. No test
  covers replay, divergence or reuse. The fix is in the runtime and changes
  no row, but a 1.0 that promises resume must have it.

**Storage.** Effect 4's own `effect/sql`; every statement a constant string
with `?` binds; the "nothing below the codec reads a payload field" rule holds
under test. Three freeze items:

- **Media by workspace path** (`packages/harness/src/shared/schemas/followUp.ts`,
  `request.ts`, `fileFields.ts`; D4 of the tech-debt note, #13874). An
  upcaster cannot turn a path into a digest, and pasted files are deleted
  after three days, so this cannot land after the freeze.
- **Upcaster numbering.** `upcast[i]` maps stored version `i+1` to `i+2`
  (`packages/harness/src/shared/schemas/rowVersions.ts`), and the freeze test
  demands `upcasts >= version - 1`
  (`src/test-kernel/schemas/rowVersions.vitest.ts`). Nine kinds are at v2 and
  `run.config` is at v6, all with empty `upcast`. Frozen as is, the first bump
  of `run.config` needs five upcasters for versions nobody released. The
  numbering must start at the released floor. Current values share one
  version with no upcast step
  (`packages/harness/src/controllers/session/currentValues.ts`), and the
  `app-state` family's schema is any JSON
  (`packages/harness/src/shared/session/valueFamily.ts`), so its frozen file
  protects nothing. No kind has a real upcaster today and no test runs one
  through `decodeRow` (`packages/harness/src/controllers/session/rowCodec.ts`).
- **Golden store.** Output still depends on whether TeX tools are installed
  (#14338; `packages/cli/scripts/generate-golden-store.mjs`).

**Self and goal mode.** The concept converged: a goal is a background script
that calls `self()` in a loop, and `self()` is awaited delegation
(`packages/harness/src/tools/codemode/SelfTool.ts`,
`packages/harness/src/tools/plan/goalScript.ts`). What is not final is what
it writes:

- `run.config.script` stores the generated template, prompt text included
  (`packages/harness/src/tools/codemode/backgroundScript.ts`). The row should
  hold a `builtIn:goal` module import, not a program body.
- The approval policy carries `goal: kind[]` plus a derived `own: 'parent'`
  that exists only to end the goal's grants on resume
  (`packages/harness/src/shared/approvalBypassKind.ts`). A goal-specific
  lifetime rule sits in the general grant shape, and the user has no re-arm
  action.
- Follow-up delivery ids come in five formats
  (`packages/harness/src/agent/runtime/scriptRun.ts` and the child-turn
  paths).
- `SelfTool.ts` reads the recorded parent "whether or not it was since
  detached"; `packages/harness/src/shared/session/runRelation.ts` treats a
  detached run as top level. A detached goal's result is stamped `peer`, and
  `needsWake` in `packages/harness/src/shared/session/runFacts.ts` then
  does not wake a conversation that has ended. This is #14242's family.

**Agents.** Done. 35 bundled YAML files, one flat persona plus at most one
plugin block, no second format, user docs complete
(`docs/guide/custom-agents.md`). The freeze makes the persona fields and the
`task:` block a user contract.
`.agents/docs/implemented/architecture/2026-09-24-plugin-architecture.md`
still lists a `continuation` field that `Plugin` no longer has and calls the
block schema Zod.

**Imports.** The app-to-harness boundary is closed except
`emitAppSignal` from `packages/harness/src/eventBus/AppSignals.ts`, used by
`packages/texra/src/tools/github/PollingSourceBase.ts` and
`RunSubscriptionRegistry.ts` (#14313). Signals are not persisted, so this
is not freeze-gated; it is the last baseline row.

## Decisions this plan needs

| #   | Decision                                                                                          | Recommendation                                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| R1  | 1.0 is the app with a frozen store; harness and llm stay 0.x                                      | Yes. Everything below assumes it.                                                  |
| R2  | Media stored by blob digest (D4)                                                                  | Yes. The only change an upcaster cannot make later.                                |
| R3  | `wakeAt` on `run.position` now, or later as a v2 with an upcaster                                 | Later. Once P1 lands, a one-field additive upcaster is cheap.                      |
| R4  | `script.call`'s `callId` and `stageId`                                                            | Drop both; derive at read.                                                         |
| R5  | Goal stored as a `builtIn:goal` module import, not a template body                                | Yes.                                                                               |
| R6  | Goal grants: an ordinary launch grant with a documented resume rule, or a user re-arm action      | Ordinary launch grant; document that a resume asks again.                          |
| R7  | AppSignals (#14313): move the two GitHub signals into `packages/texra`, or a public plugin signal | Move them into the app. No third party needs them.                                 |
| R8  | `childRunLoop.ts` off the `AbortController` residents (D1)                                        | Yes, after 1.0. No row changes.                                                    |
| R9  | Setting namespace as a catalog parameter, stored keys unchanged                                   | Yes, before the freeze; it is the one rename preparation that costs nothing later. |
| R10 | The Promise entry of the general-package design                                                   | Deferred with the rest of that design.                                             |

## The pre-freeze set

Each item is one PR unless noted. Sizes are estimates from the audits. A PR
here changes stored bytes, the freeze mechanism, or copy; nothing else.

| #   | PR                                                                                                                                                                                                                                                                                                                                        | Rows changed                                                                    | Size      | Done when                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Freeze mechanism: upcasters numbered from the released floor; a per-family version and upcast step for current values; a real schema for `app-state` or its removal from the frozen set; one test that runs a real upcaster through `decodeRow`                                                                                           | none (mechanism)                                                                | ~80 lines | A kind frozen at v6 bumps to v7 with one upcaster; `npm run storage:freeze` then `npm run test:pure` passes with the frozen directory present |
| P2  | Two parent readers (L5, #14242): `launchParent` from `run.start`, `attachedParent` from the view; delete `RunRegistry.parentOf`'s fallback chain (`packages/harness/src/agent/runtime/runRegistry.ts`); `SelfTool` and `runRelation` read the same one                                                                                    | none                                                                            | ~−60      | A detached goal's result wakes its conversation; the 13 `parentOf` call sites name which parent they mean                                     |
| P3  | Goal rows (R5, R6): `builtIn:goal` module import in `run.config.script`; goal grants as a launch grant; one follow-up delivery-id format                                                                                                                                                                                                  | `run.config`, `approval.policy` / `run.start.approvalPolicy`, `followup.queued` | ~150      | No prompt text in any row; `approvalBypassKind.ts` has no `own: 'parent'`; one id builder with every caller on it                             |
| P4  | Media by digest (R2): `followup.queued` v3, `request.opened` v4, `run.config` v7; golden store regenerated                                                                                                                                                                                                                                | three kinds                                                                     | ~100      | No `mediaFiles: string[]` path field in a stored schema; fork-from-here restores media by digest (#13874)                                     |
| P5  | Codemode: drop `script.call`'s derived fields (R4); deliver live results to the guest in commit order; tests for replay, divergence and reuse                                                                                                                                                                                             | `script.call` v2                                                                | ~120      | A script with `Promise.race` over two calls resumes identically from its rows; the three tests fail against the old delivery order            |
| P6  | Namespace as data (R9) and AppSignals into the app (R7)                                                                                                                                                                                                                                                                                   | none                                                                            | ~60       | `stateSettings.ts` has no literal `texra.` prefix; the deep-import baseline file is empty and deleted with its suite                          |
| P7  | Golden store independent of installed TeX tools (#14338)                                                                                                                                                                                                                                                                                  | none (fixture)                                                                  | ~20       | The generator's `--twice` check passes on a machine with and without TeX                                                                      |
| P8  | Copy and doc drift: the plugin-architecture note (`continuation`, Zod, `requires`, `scriptModules`); the `import` contradiction in `docs/guide/multi-agent-workflows.md`; goal copy in `packages/texra/src/tools/pluginCards.ts` and `packages/texra/src/ui/copy/delegationApproval.ts`; the stale "#14201 open" line in the 10-21 design | none                                                                            | ~40       | Every statement about goal mode in UI and docs matches `goalScript.ts`                                                                        |

Order: P1 first (everything after it is measured by its test), then P2 before
P3, then P3 to P7 in any order, P8 last. P3 and P4 both bump `run.config`, so
they coordinate on one version number or land in sequence. About 600 lines in
eight PRs.

## Freeze and release

1. **Freeze PR.** `npm run storage:freeze` writes `config/storage/frozen/`;
   the same PR changes the "Storage format" section of
   `packages/harness/AGENTS.md` to the wording the storage design's §12
   specifies, and the "Compatibility and format retirement" section of the
   root `AGENTS.md` to say that released rows are read through upcasters
   from now on.
2. **Release notes.** The 349 unreleased entries become one 1.0 section with
   a migration guide up front: no import of 0.x state, OpenRouter and Copilot
   gone, model names as `provider/id[@effort]`, the helper-model key, the
   Anthropic bearer header. The per-fix bullets follow.
3. **Preview.** `1.0.0-preview.1` through the preview path of #12168; its
   last open box is verifying the channel, which only the owner can do.
4. **Release candidate**, then `1.0.0` by the `releasing` skill.

Owner-only items on this path: the preview verification (#12168), the
`GOOGLE_API_KEY` secret (#13722), and the relay sunset (#10920), which is
independent of the tag.

## Acceptance for 1.0

- `config/storage/frozen/` exists and `npm run test:pure` passes with it.
- Every row kind in `config/storage/row-kinds-ever.json` is frozen or
  retired.
- No stored schema holds a workspace path for media, a program body for a
  goal, or a derivable id.
- A detached goal's result reaches its conversation.
- A script that issues concurrent calls resumes from its rows without
  `ScriptDiverged`.
- `1.0.0-preview.1` installs from the preview channel on all three hosts.

## Risks

- **P3 and P4 share `run.config`.** Two version bumps in flight on one kind
  conflict in `rowVersions.ts` and the golden store. Sequence them.
- **P1 changes a convention every kind relies on.** The test in
  `rowVersions.vitest.ts` is the only consumer today, so the change is
  mechanical, but it must land before any other PR adds an upcaster.
- **The audits read code; none ran it.** `node_modules` was absent in the
  audit container, so `storage:freeze` end to end, the live delivery-order
  race and the golden `--twice` check are claims from reading, to be confirmed
  by the first PR that touches each.
- **Scope creep from the design notes.** Each PR above is bounded by "changes
  stored bytes or the freeze mechanism". A reviewer who finds a refactor in
  one of them should ask for it to be split out, not widened in.

## Verified

- Read on `main` at `8fcd0a3`: the two design notes and the tech-debt survey,
  #13736, #13724, #13727, #12168, the rulings ledger's 1.0 sections,
  `rowVersions.ts` (versions and the `upcast[i]` comment),
  `rowCodec.ts` (`upcast.slice(version - 1)` and the readable floor),
  `rowVersions.vitest.ts` (`upcasts >= version - 1`), `SelfTool.ts` and
  `runRelation.ts` (the two parent readings), `runFacts.ts` (`needsWake`),
  `codeSandbox.ts` (the `settled` queue) and `toolUseDispatch.ts`
  (`replayOrder`), `followUp.ts` and `request.ts` (`mediaFiles` as paths),
  `harness.api.md` (48 exports), the deep-import baseline (one specifier).
- Counted with grep: Promise, `async`, `Effect.run*`, `AbortController` and
  Effect primitive uses per package.
- Not run: any test, `storage:freeze`, or the golden generator.
