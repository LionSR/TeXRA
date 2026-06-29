---
created: 2026-06-28
---

# Sub-PRD 04: Agent Identity - Extend #6721's `launch` Variant, Two-Brand the Boundary

> **Re-scoped by the unified design pass (2026-06-29).** This sub-PRD now builds
> on PR #6721's `RunContext` discriminated union (the `launch` variant is the
> home for the carried resolved name) and corrects three illusory guards the
> adversarial review found. The original "resolve once, carry the resolved name"
> intent is unchanged; the enforcement mechanism is rebuilt. See
> `00-overview.md` (Two sequenced tracks) for where this sits.
>
> **Decision (scope split).** The path-resolution store is already done in
> `resolveAgentForLaunch`; the resolved-name field-carry is owned by GS-6
> Descriptor. 04 owns the display-consumer repoints + two-brand boundary +
> resume-id-contract trap + quick-win deletions, shipping as CH-04.

## Context

One agent concept is threaded in three forms: `agentIdentifier` (raw, maybe
source-qualified `custom:foo` or legacy alias `chat`), `agentName` (the
prefix-stripped string from `agentName()` / `getCleanAgentName()`), and the
resolved `Agent` object (`getAgent`, the canonical resolver). The resolve-once
boundaries already exist and are correct (`resolveAgentForLaunch` at launch,
`getVisibleAgent` at validation, with `AgentConfig.agentSource` pinning the
resolved source forward).

## Problem

There is one leak. `assembleAgentLaunchContext`
(`src/agent/runtime/AgentLaunchContext.ts:273`) resolves `fullConfig.agent` into
a `ResolvedAgent` but rebuilds the config keeping `config.agent` **raw** and
discarding `resolution.resolvedName` + `resolution.entry.source`. That raw value
persists into `TaskState` and flows out as `RunContext.agentName`, the
`UsageMonitor` name, and the description/category/isRemote inputs, so ~7-10
downstream sites re-resolve or re-normalize an identity the launch boundary
already resolved (`sessionDescription.ts:90`, `isRemoteAgent` at
`AgentLaunchContext.ts:303` and `CommonCycleTypes.ts:120`,
`executionLifecycle.ts:42`, `executionQueries.ts:18/21`,
`AgentRunLifecycle.ts:171`, the snapshot matcher). That is the eliminable
re-normalization (connascence of algorithm) and re-resolution (repeated lookup).

## The trap (why the obvious fix is wrong)

Setting `config.agent = resolution.resolvedName` **breaks resume for
legacy-alias agents**. The content-addressed stream id is built at launch from
the **raw** name via `getStreamTabId` -> `getCleanAgentName` (prefix-strip
only), but `resolvedName` also alias-canonicalizes (`chat -> assistant`). Overwrite
`config.agent` and the persisted identity becomes `assistant` while the live id
was `chat@model#id`; on resume `resumeCommands.ts:210` recomputes a different id
and returns `not_resumable`. The id contract requires `config.agent` to stay raw.

## Design

Carry the resolved identity in a **new field** on #6721's `launch` variant, do
not clobber `config.agent`. The four corrections below are mandatory; the
adversarial review found that the obvious version of each is a no-op.

- **Stamp once, on the `launch` variant.** At `AgentLaunchContext.ts:273`, stamp
  `resolvedAgentName` + `agentSource` onto the launch context once, from
  `resolution`. Keep `config.agent` raw. **Drop `isRemote` from the carried
  group** - compute it at the single `:303` consumer from `agentSource` (one
  fewer carried field).
- **Build a typed `LaunchRunContext` before any cast (no `as unknown as` hop).**
  `createRunContext` today casts `as unknown as RunContext`, which erases the
  structural check, so a "required" `resolvedAgentName` would be a type-only
  promise the single producer can silently omit. Construct the literal as a
  typed `LaunchRunContext` first; omission then fails to compile at the one mint
  site. (Demoting #6721 to a plain TS union - see below - makes this trivial.)
- **Two distinct brands, not one.** Branding only the resolved `AgentName` does
  **nothing** at the resume boundary: `getStreamTabId(agent: string, ...)`
  accepts any `string` subtype, so the resolved name flows in cleanly and the
  guard is illusory. Introduce **`RawAgentIdentifier`** (minted by config parse /
  `getCleanAgentName` input) and narrow `getStreamTabId`'s `agent` parameter and
  `getCleanAgentName`'s input to it; carry `resolvedAgentName: ResolvedAgentName`
  as an **incompatible** brand. Only then does the clobber become a type error. A
  single `AgentName` brand also conflates raw-clean (`chat`) with
  resolved-canonical (`assistant`) - the exact conflation the resume contract
  forbids.
- **Disjoint consumer partition (the deletion list must not touch a keep-raw
  boundary).** REPOINT = display/label sites only: `sessionDescription` label,
  `executeAgent` description, category resolution, the `isRemoteAgent`
  blind-lookup bug at `:303` and `CommonCycleTypes.ts:120`. KEEP RAW = every
  id/snapshot/folder/DTO site: `getStreamTabId` (`:285`/`:512`, resume `:210`),
  the **`StreamSnapshotStore` matcher** (`:761,770` - struck from any deletion
  tally; it is the resume key), `History/` + legacy filename tokens,
  IPC/webview/picker DTOs, `streamTabInfo`.
- **Decide-once: `RunContext.agentName` and `UsageMonitor` stay RAW** for
  analytics continuity; the resolved name rides only the new sibling field.
  Remove them from the repoint list and document the choice in Acceptance.

**Companion shape change (#6721): demote `RunContext` from Zod to a plain TS
discriminated union.** The grounding confirmed #6721's schema is never
`.parse()`d - it is a type source consumed via cast - so the three `z.custom`
live-instance wrappers plus ~70 LOC of Zod ceremony re-present the layer beneath
them and delete for free. `launch` becomes the rich projection carrying
`resolvedAgentName`; `bare` stays the pre-existing thin ambient handle. (This is
a recommendation to the #6721 author - see the open question in `00-overview.md`;
#6722/#6723 stay Zod because they parse at a real edge.)

## Quick wins (independent)

- Delete the dead `getAgent` import (`src/agent/remote/RemoteAgentLoader.ts:12`).
- Delete the unused `resolveAgentKey` export (zero live callers).
- Delete the `normalizeAgentName` no-op on a constant
  (`src/agent/runtime/executionQueries.ts:18`).
- De-duplicate the CLI double-resolve
  (`packages/cli/src/chat/tui/commands/handlers/agentModelCommands.ts:42/50`).
- Carry `plannedRounds` on the CLI `setTaskState` payload instead of re-resolving
  for `.rounds` (`packages/cli/src/runtime/runProgressRenderer.ts:198`).

## Acceptance

- The display/label consumers read the carried resolved name; none re-resolve.
- `config.agent` stays raw at every keep-raw boundary above; `getStreamTabId` /
  `getCleanAgentName` only accept `RawAgentIdentifier`, so feeding them the
  resolved brand fails to compile.
- **The invariant test ships in this PR** and drives the **real
  `StreamSnapshotStore.matchByConfig` round-trip** for a `chat`-alias run (launch
  -> record the live `StreamTabId` -> resume recompute -> assert match), asserts
  `resolvedAgentName === 'assistant'` while the key stays `chat@...`, and asserts
  `sessionDescription` / `History/` tokens are unchanged for alias runs. (Pattern
  8's import lint is type-blind; this test is the load-bearing guard. Co-locate
  it with #6697's `resumeCommands.ts` changes to avoid a second conflict.)
- `RunContext.agentName` / `UsageMonitor` keep raw by choice (documented above).

## Risk

- Medium. The resume id contract is the sharp edge; the two-brand boundary + the
  typed-literal-before-cast + the `matchByConfig` round-trip test protect it. Net
  delta is one new field + two brands + ~10 repoints + ~5 deletions, minus ~70
  LOC of Zod ceremony from the #6721 demotion. Branding is all-or-nothing; if the
  PR is too large to review at once, split as (a) add field + stamp green, (b)
  repoint consumers, (c) brand-enforcement.
