# Agent SDK readiness: what the 2026-11-20 audit found, and what it left

Date: 2026-11-20
Status: proposed (one theme landed with this note; the rest need a decision)

Origin: a scheduled review of the harness for Agent SDK readiness — the agent
core, the model handler, the logger and the public surface — looking for
unnecessary abstractions, wrapper layers, indirection and surface the SDK does
not need, and for logical units that could run as independent agents. Read
against `main` at `f38bb2a`, with
[`2026-10-21-harness-general-package-design.md`](../architecture/2026-10-21-harness-general-package-design.md)
and the recent audit notes in this directory.

## Headline

The SDK surface is well-aligned. The "harness as a general package" program the
design doc set out has landed across its lanes (doors, vocabulary-as-data,
host dedup, the examples ladder, the one tool contract): every forbidden import
edge is zero, the root entry is 47 names, `./schemas` / `./plugins` / `./node` /
`./host` each carry only what their consumers name, and the run loop is one
program with one publisher and one input queue. What remains behind the
design's goal is enumerated below; almost all of it needs an owner decision or
is a persisted-format change deferred to the first release.

This run closed the one no-decision item left: the harness still named the
embedding app's domain and product in strings it sends a model or shows a user.

## Landed with this note

**A general package names no embedder's domain or product in runtime strings.**
The complete remaining instance set (layer-audit note item 8, left open):

- Model-facing LaTeX examples → neutral: `sessionDescription.ts`'s
  label-generation prompt (the TikZ example), and the `**/*.tex` examples in
  the `glob` tool description, its two pattern-error hints and the `grep` glob
  filter description. These feed the recorded tool definition and its digest,
  so the golden store fixture was regenerated (`golden:store`, deterministic;
  two generations identical).
- User-facing store errors → product-neutral: `databaseLayer.ts`'s
  `STORE_HELD_MESSAGE` ("Another process already has this project open") and
  `sessionStore.ts`'s feed-stopped message no longer name TeXRA. Both are
  surfaced through typed errors an embedder can catch and reword with its own
  product name; this is the second commit, droppable on its own if the owner
  would rather thread a product display name as data (see below).
- A harness-owned setting description → product-neutral:
  `GLM_CODING_PLAN_SETTING.description` (`stateSettings.ts`) said "TeXRA shows
  the plan's quota"; it now reads "the plan's quota is shown". The row is
  exported and the app renders its copy verbatim, so an embedder surfacing the
  row would have shown the app's name. Changing it regenerates the schemas API
  report.

The base system prompt (`PromptBuilder.ts`) and every other built-in tool and
setting description were already domain-neutral. The LaTeX vocabulary a run
still sees comes from the app's own `TEX_INSTRUCTIONS`
(`packages/texra/src/tools/registry.ts`), injected by TeXRA as a plugin would —
which is correct and out of scope. (The "TeXRA" that remains in harness source
is in code comments that name the reference app, not in any string sent to a
model or shown to a user.)

## Open: needs an owner decision

These are the Agent-SDK-readiness items the recent audits already costed and
left for the owner; none can land without the decision its line names. Listed
so this theme is not re-mined.

1. **The product name an embedder's users still see is a persisted format.**
   The store file `texra.db`, and the `TEXRA_APPROVAL_POLICY` and
   `TEXRA_SKILL_DIR` environment keys, carry the app's word. Neutralizing them
   is a stored-name / env-key change, deferred to the first release
   (design doc, "Re-check (2026-11-19)"). If instead the harness should keep a
   product name in user-facing text, threaded as data, that needs a
   product-display-name fact on a port (distinct from the catalog namespace
   key, which is `texra`, not `TeXRA`) — a new SDK surface, so the owner's call.
2. Decided and landed 2026-11-21
   ([the model-access note](../../implemented/simplification/2026-11-18-model-access-one-owner-per-question.md)):
   every surface lists the harness's default list; a delegation names only a
   model it was told; `setModelAccessPreference` is the one writer. Was:
   **Model handler**, three product-visible defaults.
3. **Model handler** (`2026-11-19-layer-audit-left-open.md`, items 1–3):
   whether a tool-use turn on a background-capable route should stream in the
   foreground (changes what is sent to OpenAI and Google; needs a live run);
   the per-provider image-size limits (OpenAI and Google rows carry Anthropic's
   numbers, marked not-established); and the GLM Coding Plan precedence decided
   in two packages (needs a `RouteFacts` field for user-set endpoints).
4. Landed 2026-11-20 (#15129): each of the five sites calls `logFailure` with
   its own module's channel. Was: **Logger**
   (`2026-11-19-helpers-written-by-hand-left-open.md`, item 1): five sites
   wrote `Effect.logWarning(...).annotateLogs({ data })` with no channel and
   inherited the caller's.

## Subagent boundaries

The prompt asked where logical units could run as independent agents. The
harness already has the mechanism and the boundaries are drawn: a run is one
Effect program, every child is a run that ends (`executeAgent` /
`launchProcessChild`), delegation launches children through `childLaunch.ts`,
and a plugin program is a run opened on a generated script. The two feature
PRs in flight extend exactly this seam — the goal judge is a fresh `self()`
run that did not do the work (#15116), and the context tool lets a run edit its
own view (#15123). No new split is proposed: the unit that would become an
independent agent is already a run, and inventing a second orchestration layer
beside the run loop is the shape the design doc rules out ("no flow engine").

## Checked and declined (re-read at `e6ed188`)

Every name the eight entries export (`@texra-ai/harness` and its five
subpaths, `@texra-ai/llm` and `./node`) was matched against the named imports
of every other package, the examples and the repo-root suites. The names no
file outside the defining package imports are, apart from `./schemas` (which
an open PR edits), the types the 2026-11-19 re-check of the design note read
by hand, plus four values:

- `buildFileAttachment` (`./plugins`): the builder of the attachment a tool
  result carries (`ToolFileAttachment`), the authoring counterpart of a
  public result type. Only `ReadTool` calls it today.
- `EventInputSchema` (`./transcript`): one case of `SessionViewInputSchema`,
  named in the entry's guide as the event batch a transport frames.
- `TurnRequestSchema` and `BACKEND_PROTOCOLS` (`@texra-ai/llm`): the
  sources the public `TurnRequest` and `BackendProviderId` are derived from.

Dropping any of them shrinks the published surface by one line and deletes
no code, so none is worth a public-surface change on its own. Inside the
sources, another file names every export but four interfaces, each the
field or element type of an exported shape in its own file (`PluginProgram`,
`TakenFollowUp`, `EmlImageAttachment`, and `ToolUseOpening` in `runLoop.ts`).

## Verified

- Read `main` at `f38bb2a`. `npm run gate` passed (lint, invariants, docs,
  typecheck with the harness build and packed-example type check, Effect
  diagnostics: 8 projects clean). `npm run test:changed`: 184 files, 478
  passed, 1 skipped. `goldenStore.vitest.ts`: 9 passed on the regenerated
  fixture. The `crash` project: 7 files, 8 passed.
- Not run: a live model, the desktop and VS Code e2e.
