---
created: 2026-11-16
status: proposed
---

# Agent SDK readiness: agent core, model handler, logger and surface are already well-aligned

Baseline: `main` at `6e7dcb7` (2026-11-16). Paths are from the repository root.
This note records a readiness audit of the harness agent core, the model
handler, the logger and the public surface — the areas an embedder meets first
when `@texra-ai/harness` is used as a general package. The question was whether
those areas still carry wrapper layers, shallow indirection, pass-through
modules, redundant interfaces or leaked public exports that a cleaner SDK
boundary would shed.

Method: a 16-agent adversarial debt sweep (scout → map → ideate → shortlist →
verify, each candidate defended against a REFUTE-by-default verifier) over
seven seams, plus a hand read of the logger and `modelAccess`. The territory
already owned by open PRs was excluded up front: the "programs, not agents"
refactor (#14960/#14968/#14969) and the "one owner per fact" red-flag series
across the app and hosts (#14973–#14976).

## Verdict

**The audited area is well-aligned.** Every seam read as deliberate deep-module
design, not debt. Only one new, verified net-negative change came out of it,
landed in this PR; one further duplication is a genuine single-source finding
that nets to zero elements and needs an owner's call; the rest is confirmed
clean, or already tracked by an open proposal.

This is the expected result for a tree that has absorbed the harness-general
redesign lanes (`2026-10-21-harness-general-package-design.md`, lanes 1–4 done)
and roughly fifteen structural PRs in the past two weeks. The honest readiness
signal is: the surface is small and role-separated, the run loop and lifecycle
are single-owner, and the subagent boundary is coherent. There is no large
simplification hiding in this area.

## Landed this PR

**`SwitchRefusal` collapses to a sentence.** `SwitchRefusal { reason: string;
message: string }` (`packages/harness/src/agent/runtime/modelAccess/routeDecision.ts`)
set both fields to the identical string at both construction sites
(`acceptSwitch`'s catch, and `ModelAccess.switchRejection`'s not-registered
path), and its two readers each consumed one field of that same string
(`loop/modelSwitch.ts`: `refused?.reason` for the disabled-reason read,
`new Error(refused.message)` for the refusal). One fact modelled as two
always-equal fields is self-overexposure. `acceptSwitch` and `switchRejection`
now return `string | null`; the interface is gone. Host behaviour is
byte-identical: `modelSwitchDisabledReason` still answers `string | undefined`
and `switchModel` still fails with an `Error` of the same text. −1 interface,
~−6 lines.

This is an instance of the root-AGENTS.md rule "a reason literal nothing
branches on is a message, not a kind" applied to a two-field refusal shape
whose two fields carry one fact. It is small on its own; it lands here as the
step that stands alone beside this note.

## Open finding that needs a design call

**One owner for the media-capability rule.** The rule "a PDF is a native
document when the model takes one, page-images when it only takes vision,
skipped otherwise; an image needs vision; audio needs native audio; anything
else is unsupported" is written three times in
`packages/harness/src/agent/runtime/run/mediaInput.ts` and
`FollowUps.ts`:

- `partsForFile` (`mediaInput.ts:107-154`) decides it off the file extension /
  mime type while reading bytes and rasterizing PDFs — three outcomes: a real
  part, a `skipped(...)` text part, or a **loud `Effect.fail`** on an
  unsupported type.
- `storedMediaPart` (`mediaInput.ts:240-261`) decides the same branches off a
  mime type referencing a stored digest, returning the part or `null`.
- `FollowUps.batchMessage` re-implements the PDF-as-pages fallback, differing
  only in byte source.
- `attachedMedia` (`mediaInput.ts:206`) reuses `storedMediaPart(mime, '',
  ANY_MODEL)` purely as a yes/no "any model could take this" classifier.

The shared fact is the mime/capability → medium decision. Why it is **not** a
drop-in collapse, and why the audit's verifier scored it a wash (0 elements):

1. No named function disappears. All three readers do different I/O (byte read
   - rasterize vs digest reference vs fallback) and must stay; a shared
     classifier is net +1 export, not −1.
2. The loud-fail must survive. `partsForFile` distinguishes "known type the
   model can't take" (a visible skip part) from "unknown media type" (a loud
   failure the user sees). A classifier returning `medium | null` overloads
   `null` for both and silently drops the unsupported case — a
   silent-degradation regression, not a simplification.

A correct consolidation returns a discriminated result
(`{ medium } | 'skip' | 'unsupported'`) from one classifier that the three
readers branch on, preserving the loud-fail. That removes the duplicated
branch structure and the `ANY_MODEL` sentinel but adds the classifier's
surface, so it nets ~0 elements. It is worth doing as a one-owner clarity fix,
but it changes a hot read path over ~157 models and should ride a decision
about whether the shared classifier earns its export — an owner's call, not a
scheduled-run landing.

## Confirmed clean (what was checked and left alone)

- **Model invocation / retry.** The two retry loops (`ModelInvoker.invoke` over
  the rows, `run/modelCall.callModel` off the rows) are the blessed
  "two loops, one per kind of call"; `callModel`'s predicate is a strict
  subset of `invoke`'s fold, not a copy. `resendDelayMs`, the `ModelRetryGate`,
  `routeFailureOf` and the pricing path each already have one owner. The only
  repetition is a ~3-line resend pause and one log string across the two loops;
  extracting it adds an export for −3 lines and hides the two distinct loop
  shapes — a loss. Two gate rewrites (onto `Schedule`, onto a circuit breaker)
  are already in `refuted-candidates.json`.
- **Model access / settings.** `decideReasoning`, `servingBackend` and
  `routeFactsFor` are real boundary adapters translating harness concepts (the
  validation route, run-declined routes, stored backend strings) into llm's
  pure functions. `computeModelOptions`'s four-stage pipeline is a
  performance split (route purely, batch one key-read per provider, word
  purely) over ~157 models, not shallow decomposition. `BindRequest`,
  `RouteAsk`, `RouteDecision` and `BindPlan` carry distinct field sets.
- **Delegation / subagents.** The subagent boundary is coherent. `AgentTool.ts`
  (561 lines) is a deep module; `inputFields.ts` and `proposalFlow.ts` are
  single-importer but narrow broad surfaces (six field schemas +
  attachment resolution; the full proposal/approval handshake with live
  re-validation) to a few entry points — the exempted "narrowing to one entry
  point", not a pass-through. The three `ChildRunDelivery` builders (subagent =
  output+lines, background = exit+lines, script = summary+response) have
  genuinely distinct shapes and are **not** a dual system; a unifying builder
  would share only `{ family, runId }`. The switch ladders (`childEndReport`,
  `proposalRefusalResult`, `delegatedChildGrants`, `describeSubagentProgress`)
  are exhaustive discriminated unions with distinct per-branch effects and
  should stay code, not data tables. The one duplication here — the wall-time
  `${(ms/1000).toFixed(1)}s` formatter across four sites — is already
  `2026-11-15-run-end-audit-left-open.md` finding #1.
- **Run loop core.** `runLoop.ts`, `step.ts`, `toolUseDispatch.ts`, `hooks.ts`,
  `toolGuard.ts` are each one owner over much behaviour with file-local
  helpers (correct deep-module shape). The exported helpers (`hooksOf`,
  `offeredBy`, `dispatchTools`, `resolveActivations`, `modelSwitchPort`, …)
  each have a real cross-module consumer, not forwarding. Cosmetic only:
  `runLoop.ts` writes outcomes as `RUN_OUTCOME.X` in some branches and bare
  `'failed'`/`'completed'`/`'cancelled'` literals in others (all typed against
  `RunOutcome`); below the bar and churny to touch alone.
- **llm history lowering.** The genuinely shared decisions are already single
  functions (`replayableHistory`, `systemUpdateText`, `parseOutboundToolArguments`,
  `sameModelOrigin`, `EVIDENCE_PROTOCOL`). What repeats across the three
  provider codecs is a ~25-line role/part skeleton whose every branch body is
  provider-specific (Anthropic lookahead, Google step grouping, OpenAI
  per-part items + `coveredItemCount`); a shared walk adds a handler interface
  and generics for no behaviour shared — a loss.
- **Run lifecycle / registry.** Among the most carefully designed areas in the
  tree. The `RunEntry` five-state machine is fully load-bearing; the five
  "launch wrappers" are not pass-throughs (grant/limit resolution, a distinct
  process-child terminal, cut-finding on fork/resume, row projection); the two
  run programs already share one terminal (`endVerdict` + `commitEnd`); the
  stop-reason literals `'user'`/`'released'` are both branched on.
- **Public surface.** The root entry is 35 exports (below the design doc's 59
  target). The eight entry files are flat re-export barrels with no logic — the
  documented, exempt shape for a frozen public boundary — with zero duplicate
  exports across them and clean role separation (index = embedder, node = Node
  platform, plugins = authoring, schemas = browser-safe, host = full
  composition, transcript = renderer; llm index/node split by browser-safety).
  Every 0-external-consumer export traced is a live internal member of another
  exported public signature (an error channel, a param type, a union branch),
  not leaked plumbing.

## Rejected / out of scope

- Extracting the resend-pause helper, the llm part-walk, and a
  `ChildRunDelivery` unifier: each adds surface for no shared behaviour (net
  loss). Recorded so a later pass does not re-discover them.
- `HistoryQueryRefused.reason`: the verifier found it collapsible, but
  `2026-11-03-storage-errors-and-stop-paths.md` §3 already **checked and kept**
  it on 2026-11-06 because `rejected` is branched on in the executions query.
  Not relitigated here.
