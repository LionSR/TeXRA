---
created: 2026-06-28
---

# Sub-PRD 06: Reduce the `resolve*` Method Surface

## Context

A scan finds **165 distinct `resolve*` identifiers across 837 references**. The
verb "resolve" has lost its meaning: it is used for at least four unrelated jobs,
which is connascence of name (everything is "resolve") plus real synonym and
dead duplication.

## Problem

The `resolve*` surface conflates four distinct operations under one verb:

1. **Settle a pending async request (coordinator family).** `resolveProposal`,
   `resolveUserQuestion`, `resolveToolEditPermission`, `resolveRetryRequest`,
   `resolvePlanApproval`, `resolveExternalInquiry`, `resolveBashPermission`,
   `resolveAgentProposal` - each appears ~3 times (coordinator class +
   `runCoordinatorCommands` + a runtime command), so ~8 concepts become ~24
   `resolve*` methods. This is the densest cluster and the runCoordinatorCommands
   boundary already half-owns it.
2. **Identifier -> object/config lookup.** `resolveAgent`, `resolveAgentForLaunch`,
   `resolveLaunchModel`, `resolveModelOptions`, `resolveCliAgentEntry`,
   `resolveRuntimeAgentIdentifiers`, plus synonyms and dead ones
   (`resolveAgentKey`, `resolveRuntimeAgentKey`, `resolveCliAgent` vs
   `resolveCliAgentEntry`). The agent-identity audit (Sub-PRD 04) found the core
   lookup boundary is correct (`getAgent` is the canonical resolver); the smell
   here is the synonyms and dead aliases, not the boundary.
3. **Filesystem / storage path.** `resolveStoragePath`, `resolveWorkspacePath`,
   `resolveRunDir`, `resolveResourcesPath`, `resolveSkillSourcePath`, etc.
4. **Config / options / tools.** `resolveAgentTools` (15 refs),
   `resolveToolDefinitions`, `resolveModelAvailability`.

Naming everything "resolve" forces a reader to open the body to learn what kind
of operation it is, and it hides the synonyms and dead methods in the noise.

## Design

This is a naming and grouping cleanup, deliberately **not a blanket rename**
(165 renames would be churn far over the win). Three focused moves:

1. **Reserve "resolve" for one meaning and converge the coordinator family.**
   Treat `resolve*` as "settle a pending async request" and collapse the ~8
   settle concepts behind `runCoordinatorCommands` so a host calls one
   intention-level decision per kind, not a coordinator method plus a command
   wrapper. (`runCoordinatorCommands` already owns plan/proposal/retry; extend
   the same shape to the rest, and keep the coordinator classes private.)
2. **Delete dead and synonym resolvers.** `resolveAgentKey` (zero live callers,
   already in the lint's deleted-export guard), `resolveRuntimeAgentKey`, and the
   `resolveCliAgent` / `resolveCliAgentEntry` duplication. Per the deep-modules
   rule, a synonym that adds no vocabulary is deleted.
3. **Rename the other families by intention, opportunistically.** Lookups use
   `get*` / `lookup*`; paths use `locate*` / `*Path`; tool/option computation
   uses `build*` / `compute*`. Apply when a file is already being touched (the
   Rule-of-Three / strangler discipline), not in one mega-rename. Codify the
   convention in AGENTS.md so new code does not add to the pile.

## Scope

- `src/agent/runtime/runCoordinatorCommands.ts` and the coordinator classes:
  converge the settle family; make coordinator classes private.
- `src/agent/runtime/agentResolution.ts` / `agentRegistry`: delete the dead and
  synonym agent resolvers (coordinate with Sub-PRD 04).
- AGENTS.md: add the verb convention (resolve = settle pending request).
- Everything else is opportunistic per-file renaming, not a tracked deliverable.

## Acceptance

- The coordinator settle family is one intention-level surface, not three layers
  of `resolve*`.
- The dead/synonym agent resolvers are gone (lint-guarded).
- AGENTS.md states the `resolve*` convention; CI/review enforce it for new code.
- Distinct-`resolve*` count drops materially from 165 (target: the coordinator
  and agent clusters, roughly 30-40 names, reduced to their intention-level set).

## Risk

- Low-to-medium, mostly churn risk. The hard rule: do not do a blanket 165-method
  rename; converge the coordinator cluster, delete the dead/synonyms, and let the
  rest follow the convention as files are touched.
