# Agent SDK readiness: what the 2026-11-24 audit landed, and what it left

Date: 2026-11-24
Status: proposed (one theme landed with this note; the rest are below the PR
bar on their own, reverse a recent deliberate ratchet, or need an owner
decision, and are recorded so the theme is not re-mined a fifth time)

Origin: a scheduled review of the harness for Agent SDK readiness — the agent
core, the model handler, the logger and the public host surface — looking for
unnecessary abstractions, wrapper layers, pass-through indirection,
single-caller helpers, re-export shims, redundant interfaces and dual
representations of one fact, and for logical units that could run as
independent agents. Read against `main` at `dda1913`, continuing
[`2026-11-20-agent-sdk-readiness-audit.md`](2026-11-20-agent-sdk-readiness-audit.md),
[`2026-11-21-agent-sdk-readiness-shallow-indirection.md`](2026-11-21-agent-sdk-readiness-shallow-indirection.md)
and
[`2026-11-23-agent-sdk-readiness-left-open.md`](2026-11-23-agent-sdk-readiness-left-open.md).
A 12-mapper read of the model-invocation, run-lifecycle, model-access,
logger-trace, public-SDK and storage seams, open ideation over the merged
map, a shortlist, and adversarial net-gain verification of six candidates.

## Headline

The SDK surface stays well-aligned, for the fourth run running. Every seam the
mappers read came back "substantially healthy and well-factored": the
run-loop/invocation seam has a clean producer/consumer image boundary and one
deep per-call dispatch module; the run-lifecycle registry is one state machine
with one launch owner (`executeAgent`) and one terminal (`endRun`); the
logger-trace seam is one deep `AgentTrace` interface whose every sugar method
has live callers; and the public entries each carry what their consumers name.
No dual system, no pass-through to delete, no single-source conflict survived.

This run landed one theme: **three run facts each have a single owner, but a
second site re-derived each by hand — and one of those copies carried a latent
bug.** The remaining candidates are below the element/LoC bar on their own,
reverse a deliberate ratchet landed three days ago, or are owner-gated, and are
recorded below.

## Landed with this note

**One owner for the shown instruction (a latent cross-surface bug).**
`getDisplayedInstruction` (`agent/runtime/sessionDescription.ts`) is the
documented single owner of "the instruction text shown for a run: the display
override when it carries content, otherwise the real instruction," and its doc
says it exists "so a blank display override can never surface as a blank label
on one surface and the instruction on the other." It trims both sides
(`displayInstruction?.trim() || instruction.trim()`). The SessionStart opening
hook (`loop/hooks.ts`) open-coded the same choice **untrimmed** —
`run.config.displayInstruction || run.config.instruction || text` — so a
whitespace-only display override would surface as a blank SessionStart prompt
while every other surface fell through to the instruction, and a padded
override reached the hook prompt with its padding. The hook now calls
`getDisplayedInstruction(run.config) || text`, keeping the `text` fallback. The
only behavior change is the intended one: surrounding whitespace is now trimmed
off the instruction in the SessionStart hook prompt, matching the stream tab and
session description. No public, persisted or wire change; the golden-store
fixtures use unpadded instructions, so no fixture regenerates.

**Two run facts routed through their owner (behavior-identical).**

- `leftoverChildren.ts` hand-rolled the kind→noun mapping
  (`kind === 'process' ? 'command' : kind`) that `NESTED_NOUNS`
  (`shared/schemas/runIdentity.ts`) already owns totally
  (`satisfies Record<RunIdentity['kind'], string>`); it now indexes the table.
- `delegation/AgentTool.ts` compared a child's outcome against the literals
  `'cancelled'` / `'completed'` where `RUN_OUTCOME`
  (`shared/schemas/run.ts`) is the one owner of that triad; it now reads
  `RUN_OUTCOME.CANCELLED` / `RUN_OUTCOME.COMPLETED`. The value pass-through at
  `childResult`'s return (`outcome: result.outcome`) and the type-description
  string are untouched.

Both are identical-value swaps: no element removed, no behavior change, but the
fact is read from its owner, not re-spelled.

## Open: below the bar, ratchet-reversing, or owner-gated

None of these can land as a net win on its own in a scheduled run. Recorded so
the theme is not re-mined.

1. **Three dead public-entry re-exports** (`buildFileAttachment` on `./plugins`,
   `EventInputSchema` on `./transcript`, `TurnRequestSchema` on
   `@texra-ai/llm`). Each has no external entry-path consumer and keeps its one
   internal caller importing from the definition module. Verified REAL but −3
   exports / ~−8 LoC — far below the audit PR floor, and the 2026-11-20 run
   already "checked and declined" exactly these on the same evidence, reasoning
   they are documented authoring counterparts / derivation sources an embedder
   may name. (`BACKEND_PROTOCOLS`, twice proposed as a fourth, is **live** —
   `providerSettings.ts` imports it — and must stay.) Dropping them is a
   public-surface change (`npm run docgen` regenerates `config/api-reports/` and
   `docs/api`) worth doing only folded into a broader public-surface pass, with
   the owner's agreement that these are not intentional SDK headroom. Also sweep
   the standalone `type BuildFileAttachmentOptions` if `buildFileAttachment`
   goes.

2. **Collapse `IMAGE_LIMITS` to one constant** (`packages/llm/src/protocol.ts`).
   Its three protocol rows are byte-identical `{maxDimension: 8000,
   manyImageMaxDimension: 2000}`, two carrying comments that admit the
   OpenAI/Google numbers are the Anthropic row's placeholders, and
   `mediaInput.ts` runs `Math.min` over `Object.values` to defend a divergence
   that cannot occur. Owner-rule-correct ("a column constant or derivable across
   its rows is a special case written as data") and ~−26 LoC / −1 element, **but
   it reverses the deliberate per-protocol compile ratchet landed in #15122
   (~3 days ago)**, whose documented point is that a new protocol does not
   compile without a row and the placeholder rows await real per-provider
   numbers. That per-provider image-size question is itself one of the open
   owner decisions (2026-11-20 note, item 3). Belongs under "Needs your eye" as
   its own commit, not a silent land — owner's call whether the extensibility
   seam or the owner-rule wins.

3. **Fold `PLAN_EFFORTS` onto the `PLAN_ROUTES` row**
   (`packages/llm/src/models/reasoningChoice.ts`). The table is 3/4 `undefined`
   with one live value. This is explicitly **Design A** of
   [`2026-11-19-a-subscription-plan-is-one-row.md`](../architecture/2026-11-19-a-subscription-plan-is-one-row.md),
   which was not chosen (Design B was built) and "waits on a naming decision" —
   owner-gated, cannot land in a scheduled run.

4. **Inline `NOTICE_OF`** (`packages/texra/src/controllers/server/hostWindows.ts`).
   A single-caller identity handler table whose every body is
   `(payload) => ({ event: '<key>', payload })`. Tempting as −1 element / ~−11
   LoC, but `NOTICE_OF` is typed `PresentationEventHandlers<…>`, a **total**
   table whose contract (omitting a key is a compile error) is the exhaustiveness
   the type exists to give; inlining needs an `as Notice` cast at the call site
   that discards it. Trading a compile-checked total mapping for a cast is a net
   safety loss against the "errors defined out of existence by the shape" rule.
   The table earns its keep; left as it is.

## Verified dead-ends (recorded so a later run does not chase a false win)

- `BACKEND_PROTOCOLS` is a **live** export (`providerSettings.ts` imports it
  from `@texra-ai/llm`, used at three sites); the "four dead exports" framing is
  wrong, the real count is three.
- The `acceptSwitch` model-switch dry-run (`modelAccess/routeDecision.ts`) is
  **not** a second owner of the bind decision: `decideRoute` and
  `decideReasoning` are already single owners, and both `bindRoute` and
  `acceptSwitch` compose them. `acceptSwitch` is a legible predicate that
  sequences the owners, not a re-derivation; extracting a shared "head" is
  element-neutral and adds an intermediate type. WASH.
- The two loose-provider-JSON readers (`failureReply.ts` vs `planUsage.ts`)
  differ in coercion by design (`failureReply` must not read `'429'` as a
  number); a shared toolkit would need opt-in flags — an option for a special
  case.
- `PLAN_LIMITS` (`verdict.ts`) is a genuine function table: `glmPlanLimit`
  carries a `secondsUntilChinaTime` reset the others lack; a `{codes}/{phrase}`
  data shape would reintroduce a GLM branch.
- Inlining `debugMessageSaver` into `ModelInvoker` deletes a file but enlarges
  an ~845-line hotspot with filesystem/config concerns it otherwise does not
  carry — the wrong direction of change. Take it only if other `ModelInvoker`
  work already opens that file.

## Subagent boundaries

Unchanged from the three prior runs: a run is already the independent-agent unit
(`executeAgent` / `launchProcessChild`), delegation launches children through
`childLaunch.ts`, and a plugin program is a run on a generated script. No new
split is proposed; a second orchestration layer beside the run loop is the shape
the design doc rules out ("no flow engine").

## Verified

- Read `main` at `dda1913`. The changes are internal; no public export, no
  persisted/wire/digest change. (Gate and test results recorded in the PR body.)
- Not run: a live model, the desktop and VS Code e2e.
