---
created: 2026-06-28
---

# Sub-PRD 04: Agent Identity - Resolve Once, Carry the Resolved Name

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

Carry the resolved identity in a **new field**, do not clobber `config.agent`:

- At `AgentLaunchContext.ts:273`, stamp `resolvedAgentName` + `agentSource` (and
  `isRemote`) onto the launch context once, from `resolution`. Keep
  `config.agent` raw.
- Brand `AgentName` (`z.infer<AgentNameSchema> & { __brand }` or Zod `.brand()`)
  so only the resolver/normalizer can produce it; re-normalization stops
  compiling.
- Repoint the ~7-10 deep consumers to read the carried resolved field instead of
  re-resolving. Fix the latent `isRemoteAgent` bug at `:303` (it re-looks-up the
  bare name through blind source-priority though the resolved source is in
  scope).
- Keep `config.agent` raw at the legit string boundaries: `getStreamTabId`
  (`:285/:512`, resume `:210`), `StreamSnapshotStore` matching, `History/` folder
  and legacy filename tokens, IPC/webview/picker DTOs, `streamTabInfo`.

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

- The deep consumers read the carried resolved name; none re-resolve.
- `config.agent` stays raw; a test proves legacy-alias resume still matches the
  live stream id.
- `RunContext.agentName` / `UsageMonitor` value change for alias runs is called
  out explicitly (analytics continuity), or those keep raw by choice.

## Risk

- Medium. The resume id contract is the sharp edge; the keep-raw rule above
  protects it. Net delta is one new field + a brand + ~10 repoints + 5
  deletions.
