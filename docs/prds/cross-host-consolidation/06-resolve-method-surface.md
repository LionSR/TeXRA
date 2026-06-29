---
created: 2026-06-28
---

# Sub-PRD 06: Collapse the `resolve*` Indirection Layers (the SSOT slice is already done)

> **Re-scoped twice (2026-06-29).** First from a naming cleanup to a
> data-structure SSOT fix (resolve once, store the resolved value, read it). Then
> a **field audit of all ~176 `resolve*` identifiers** (seven domain auditors +
> an adversarial staleness-trap pass) overturned the store thesis for this
> surface: **zero** store-at-source wins survive. The data model is already
> SSOT-clean; the remaining re-resolutions are live accessors or keep-raw keys
> that _must not_ be stored. The actionable subtractive work is **fewer layers**
> (collapse indirection wrappers), not data-structure changes - which still
> serves the north star, by deletion, with no renaming and no new stores.
>
> **Superseded for the coordinator slice.** The `resolveRuntime*` wrapper-collapse
> (cull 1) is absorbed by the gold-standard **PendingRequests** PRD
> (`docs/prds/2026-06-29-prd-runtime-gold-standard.md`), which deletes the
> coordinator stack wholesale rather than thinning it. Keep this doc for the CLI
> inline culls (2-3) and the audit evidence (store-at-source wins = 0).

## The principle (unchanged, and now proven satisfied)

Resolve-once / SSOT rule: see the patterns PRD (Pattern 3). **The audit's job was
to find defects against that rule. It found none on this surface** - and that null
result is the finding.

## The field audit result (the evidence)

- **Surface:** ~176 distinct camelCase `resolve*` identifiers (~163 production,
  ~13 test-only); ~702 non-test references. (Prior estimate ~165/~837; the count
  is higher because the `resolveRuntime*` and `resolveCli*` thin-wrapper families
  inflate the namespace, and refs are lower because the branch already trimmed
  host/cli runtime pass-throughs.)
- **Classification after the adversary: A = 0, B = 19, C ≈ 134.**
  - **A (store-at-source) = 0.** Every candidate was overturned, for one of two
    reasons:
    - **Already realized** (the 04 template is _done_): `resolveAgentForLaunch`
      -> `resolvedName`, `resolveToolDefinitions` -> `settings.tools`,
      `resolveResourcesPath`/`resolveCliResourcesPath` -> stored on context,
      `resolveChatDefaults` -> `ChatDefaults`. These resolve once and store a
      canonical field; **0 re-resolutions left to delete**.
    - **A trap** (storing injects staleness or breaks keep-raw): `resolveCliLaunchAgent`
      (registry reloads between pre-flight and launch), `resolveConfiguredCustomDir`
      (re-reads a mutable setting + live FS probe), the preset-key resolvers
      (sign-in-dependent live catalog), `resolveModelOptions`/`resolveCliRunModel`
      (`RunContext.model` precedent - model + availability are live),
      `resolveOutputFiles` (unions a Set that grows mid-run), and the raw
      `config.agent`/`config.model` keep-raw boundary (04).
  - **C ≈ 134 stay** (the discipline says so): single-registry lookups
    (`resolveAgent`), per-call pure derivations (the whole paths-storage bucket),
    live accessors (`resolveAgentTools`, `resolveApiKey`, `resolveModelAvailability`),
    and keep-raw resume/snapshot keys (`resolveResumeState`, `resolveBaseFilesForDiff`).
  - **B = 19** are async-settle (below), not stores.

## What to actually do: collapse indirection layers (no rename, no store)

The subtractive budget is layer deletion. Of the three culls below, only the two
CLI inlines (2-3) are 06's work - cull-1 is owned by GS-3. None touches a live
value or a keep-raw key:

1. **Cull-1 (the `resolveRuntime*` wrapper-collapse)** is owned by the
   gold-standard GS-3 PendingRequests (deleted wholesale, not thinned; see that
   PRD's section 9). Not 06's work.
2. **Bucket 2 - inline the 6-deep CLI model resolve stack.**
   `resolveCliRunModelCandidate` (`runModel.ts:54`) and `selectCliRootModel`
   (`rootModelSelection.ts:9-26`) are single-caller pass-throughs over
   `resolveCliRunnableModel` -> ... -> `resolveCliModelAccessEntry`. Inline them
   (~2 layers), preserving the live access-list consult (do not snapshot the
   model).
3. **Bucket 1 - inline the `resolveCliAgent` / `resolveCliLaunchAgent` /
   `resolveCliAgentEntry` trio** over one registry lookup (~2 names over 1 fact).
   Brushes the 04 keep-raw boundary, so land **after sub-PRD 04 is settled**;
   lowest leverage, do last or drop.

## B: the async-settle family (classified, mostly stays)

`BasePromiseCoordinator.resolveRequest` settles a `pDefer()` deferred; the family
`resolve*Approval/Proposal/Question` bottom out there. None re-derives a stored
fact - no data-model defect, no store. The only subtractive move is the wrapper
collapse in cull 1. `resolveSession`, `resolveBeforeWaiting`, `resolveWakeResult`
settle live promises and stay; `resolveExternalInquiryIndex` is a per-render clamp
(storing it would be a render-time-workaround anti-pattern).

## The discipline is a fence (this is why A = 0)

Every additional store this surface invites is either already done or a staleness
bug. The test that produced the null result is **"static for the storing object's
lifetime, applied field by field"** - not "the name starts with `resolve`." Keep
the fence: a future census that re-raises a Group-2 candidate must re-clear the
static-or-live and keep-raw checks first (all eleven failed).

## Reconcile with sub-PRD 04 before 04 ships

The audit reports `resolveAgentForLaunch` **already stores** `resolvedName` (read
at `agentLoad.ts:96`) with 0 re-resolutions left at that site, while 04's premise
is ~10 downstream re-resolutions of the identity. These are likely different
scopes (the stored `ResolvedAgent` is used for path resolution; the ~10 are
_display_ consumers that never received the carried name). **Reconcile the two
before 04 ships:** confirm the ~10 display consumers actually re-resolve today, or
04 shrinks to near-zero. Do not double-count.

## Acceptance

- The distinct-`resolve*` count drops because **wrapper/indirection layers are
  deleted** (cull 1-3), not renamed and not via any new store.
- **No store-at-source PR is written** against this surface; if one is proposed it
  must first clear the static-or-live + keep-raw checks that A = 0 already failed.
- No live accessor (`RunContext.model` class) is snapshotted; no keep-raw key is
  folded into a stored payload.

## Risk

- Low. The only real hazard is a future refactor re-introducing a Group-2 store
  (staleness) on the strength of a `resolve*` name. The fence above is the guard.
  Cull 1 shares the runtime-command boundary with #6721, so sequence after it.
