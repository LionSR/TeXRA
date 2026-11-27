# Declarations and modules with no consumer, after the big deletions

Date: 2026-11-27
Status: proposed (one theme landed with this note; four harness-type cases are
recorded as deferred, with the reason each is not a scheduled-run land)

Origin: the scheduled review for Agent SDK readiness — the agent core, the
model handler, the logger and the public host surface — looking for unnecessary
abstractions, wrapper layers, pass-through indirection, single-caller helpers,
re-export shims, redundant interfaces and dead declarations. Read against `main`
at `3bc72f1`, continuing the five prior agent-SDK-readiness notes
([2026-11-20](2026-11-20-agent-sdk-readiness-audit.md),
[2026-11-21](2026-11-21-agent-sdk-readiness-shallow-indirection.md),
[2026-11-23](2026-11-23-agent-sdk-readiness-left-open.md),
[2026-11-24](2026-11-24-agent-sdk-readiness-left-open.md),
[2026-11-25](2026-11-25-agent-sdk-readiness-left-open.md)).

## Headline

The SDK seams stay well-aligned, as the five prior runs found: the run-loop is
one program with one publisher, every forbidden import edge is zero, and no
shallow presenter or re-encoding wrapper survives. Those seams held, so this run
widened to the mechanical question the guardrail "Exports are contracts; default
to file-local; a new export needs a consumer in the same PR" asks directly: which
exported declaration or whole module has **no consumer anywhere in the repo**?

Four large deletions landed since the last run — the document pipeline and task
programs (#15229), the conversation-first UI (#15250), "trust the model" with the
replacement engine (#15253) — and their evening sweeps (#15251, #15252) caught
the app- and harness-level leftovers they named. This run swept what those
sweeps did not: a dead-export scan over 4,235 exported declarations in the six
`packages/*/src` trees, and a dead-module scan over every `.ts`/`.tsx` there,
each cross-checked against the whole repo (scripts, `.mjs` and JSON config
included, which an earlier draft's `packages src`-only check missed — it would
have wrongly deleted `commandManifest.ts`, read by
`scripts/sync-package-contributes.mjs`).

The tree is tight: 27 of 4,235 exports (0.6 %) had no external reader, and only
two were a whole dead module (`editedFileMatch.ts`, `Pagination.ts`). The two
dead declarations — `copyDereferenced` and `PENDING_BOX` — trace directly to
#15229's deletion.

## Landed with this note

**Four leftovers no consumer reads, deleted.**

- `copyDereferenced` (`packages/harness/src/utils/files/fsDurability.ts`): an
  Effect helper that dereferences symlinks for a self-contained snapshot. Its
  last caller was the document pipeline, removed in #15229; grep finds no caller
  repo-wide. Deleted.
- `PENDING_BOX` (`packages/cli/src/tui/ui/glyphs.ts`): the `□` heading marker
  "for a round's results in the document task run details" — the document task
  runs #15229 deleted. No reader anywhere. Deleted.
- `editedFileMatch.ts` (`packages/texra/src/ui/progress/`): a whole module whose
  only export, `matchesEditedFile`, derived the Tools sheet's edited-file list.
  No importer and no consumer of the symbol. Deleted (33 lines).
- `Pagination.ts` (`packages/texra/src/ui/settings/components/shared/`): a whole
  module defining the `list-pagination` custom element. No module imports it, so
  the element is never registered, and the `<list-pagination>` tag and its
  `PageChangeDetail` event appear in no template. The one unimported custom
  element in the app. Deleted (161 lines).

**Thirteen declarations with no external reader made file-local.** Each is used
only inside its own module, so the `export` keyword was contract headroom with
no consumer. All are in the bundled app packages (`texra`, `cli`), which publish
no `.d.ts`, so dropping `export` changes nothing a build or another package sees:
`DerivedSettingsSnapshot`; `isTaskFileGlob` and `splitMediaFiles`;
`ModelAccessProviderId` and `ModelAccessPreferenceOutcome`; `OverleafTokenSpec`;
`ModelChoice` and `modelChoices`; `fileSelectLayoutStyles`;
`IconActionButtonOptions` and `LabeledActionButtonOptions`; `OverleafCloneNotice`;
`ToolPluginSetup`.

A fourteenth, `estimateLiveTranscriptEntryRows`
(`packages/cli/src/chat/tui/panes/transcriptViewport.ts`), is the same shape but
left as it is: the open #15258 edits that declaration's signature, so dropping
its `export` would collide for one keyword. Fold it into a later run if the file
is otherwise open.

**One math-markup value type read from its owner.**
`LatexdiffMathMarkupValue` (`packages/texra/src/shared/constants/latexConfig.ts`)
is the owner of "the decoded latexdiff math-markup value," yet its one would-be
reader, `LATEXDIFF_MATH_MARKUP_SETTING` in `latexdiffSettings.ts`, re-derived the
type inline as `(typeof LATEXDIFF_MATH_MARKUP_VALUES)[number]` — so the owner
read as dead. The setting row now names `LatexdiffMathMarkupValue`, which removes
the re-derivation and gives the owner its consumer.

## Deferred: four harness types, declaration-emit cost over nil value

The same scan flagged four `export`ed types in the harness whose only readers are
in their own module. Unlike the app packages, the harness publishes `.d.ts`
(`packages/harness/dist/`), so dropping `export` is not free, and the value of
the keystroke is nil. Recorded so a later run does not re-raise them as easy wins:

- `ToolUseOpening` (`agent/runtime/loop/runLoop.ts`) is the return type of the
  **exported** `openToolUse` and the parameter of the **exported** `runToolUse`.
  It is part of two exported signatures; unexporting it would force the
  declaration emit to inline or error, for no gain. It is not a dead export — it
  is a named type two exported entries share. Leave exported.
- `TakenFollowUp` (`shared/session/runRowsShape.ts`), `ContextReplace`
  (`shared/session/runFacts.ts`) and `EmlImageAttachment` (`tools/emlParser.ts`)
  are each used only inside a non-exported type in the same file. Dropping
  `export` is most likely safe (the sibling non-exported types already compile in
  the exported shapes that hold them), but the payoff is one keyword each and the
  only way to be sure is the full declaration build. Below the bar on their own;
  fold into a harness public-surface pass if one opens for another reason.

`LocalRuntimeStateSchema` (`shared/schemas/sessionViewInput.ts`) is in the
published `harness.schemas` API report — intentional SDK surface, not dead.

## Subagent boundaries

Unchanged from the six prior runs: a run is already the independent-agent unit
(`executeAgent` / `launchProcessChild`), delegation launches children through
`childLaunch.ts`, and a plugin program is a run on a generated script. No new
split is proposed; a second orchestration layer beside the run loop is the shape
the design doc rules out ("no flow engine").

## Verified

- Read `main` at `3bc72f1`. The deletions remove symbols with no repo-wide
  reference (scripts and config included); the unexports keep every in-file use;
  the latexdiff change is type-identical (`LatexdiffMathMarkupValue` **is**
  `(typeof LATEXDIFF_MATH_MARKUP_VALUES)[number]`). No persisted, wire or public
  change: `check:api-report` reports the exports unchanged.
- `npm run gate` passed (lint and invariants, docs, typecheck + format with the
  harness declaration build, Effect diagnostics on 8 projects).
- `npm run test:changed`: 168 files, 463 passed, 1 skipped.
- Not run: the full `npm test` with the crash replays, a live model, the desktop
  and VS Code e2e.
