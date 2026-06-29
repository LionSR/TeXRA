---
created: 2026-06-28
---

# Cross-Host Consolidation: Overview

## Overview

After the runtime/host decoupling, an audit of what still repeats across the
three hosts (`packages/cli`, `packages/extension`, `packages/desktop`) found a
clear, narrow pattern. The runtime **semantics** (`@agent/runtime/*Commands`)
and the wire **shapes** (per-view message schemas, option and permission DTOs,
the `ProgressBackend` primitives) are genuinely single-source. The residual
change-amplification has migrated **one layer up**, into host **orchestration
and dispatch wiring**, and it is concentrated in the **extension and desktop
pair**. The CLI almost always differs legitimately (it is an Ink TUI, not a
webview rail).

The throughline: the VS Code extension routes board and settings actions through
the host-neutral controllers in `src/controllers/*`, while the Electron desktop
re-implements several of the same sequences inline and has drifted. Desktop is
the laggard, not a second design. The remedy is not a universal host UI. It is
to make desktop consume the same shared owners the extension already uses, and
to give a few still-unshared sequences one owner.

This is the planning umbrella. Each sub-PRD below is a discrete, independently
mergeable PR. They follow `docs/prds/2026-06-28-prd-architecture-patterns.md`
(Pattern 1 one-core-many-hosts, Pattern 2 deep modules, the "fewest layers"
objective) and the program in `docs/prds/2026-06-27-prd-runtime-host-decoupling.md`.

## Thesis

A user action should flow through three hops, not four (see the patterns PRD's
Overriding Objective). Where a sequence appears in two hosts, it has a
missing owner. Where a host re-implements a controller the other host already
calls, the host has skipped the seam and will drift. The work here closes those
gaps; it does not flatten genuine host affordances (shells, IPC vs webview vs
Ink delivery, CLI-only in-run controls).

## The sub-PRDs

| #   | Sub-PRD                                                                                                                          | Owner it lands in                                     | Amp         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------- |
| 01  | Desktop adopts the shared progressView controllers (delete, pending-permission)                                                  | `src/controllers/progressView/*` (existing)           | High        |
| 02  | One `requestRuntimeStreamResume` command (snapshot/auto-resume)                                                                  | `src/agent/runtime/resumeCommands.ts`                 | High        |
| 03  | `createSettingsViewCommandHandlers` grouped sub-registries                                                                       | `src/controllers/settingsView/*` (new)                | High        |
| 04  | Agent identity: resolve-once, carry the resolved name (field-carry -> GS-6 Descriptor; branding/repoints/resume-id trap = CH-04) | `src/agent/runtime/AgentLaunchContext.ts`             | Medium      |
| 05  | External-inquiry resolution policy into `humanInputCommands` (host-aware decision policy; NOT absorbed by GS-3)                  | `src/agent/runtime/humanInputCommands.ts`             | Medium      |
| 06  | Audit evidence (store-at-source = 0) + CLI culls; cull-1 -> gold-standard GS-3                                                   | CLI inline culls 2-3 (cull-1 -> GS-3 PendingRequests) | Low-Med     |
| 07  | UI as a pure reactive projection of the runtime (one store, hosts derive)                                                        | `src/shared/progressView/backend` (generalize)        | Medium-High |

## Priority order

The unified design (see `ARCHITECTURE-MAP.md` and `EXECUTION.md`) sequences this
as two tracks - SHAPES (the discriminated-union PRs #6720-6723) land first, FLOW
(these sub-PRDs) consume them. The phased execution/merge order (the GS / SDK / CH
queue) lives in `EXECUTION.md`.

Sub-PRD 07's full scope is roughly half its first-draft promise: the record-store
delta patch type does not exist yet and must ship before the frontend mirror
reducer can be deleted, so the status-slice lands now and the delta-patch is the
medium-term direction, not a quick win.

## Immediate drift bugs

The duplication has already produced three behavior bugs. Each is small and can
land before any consolidation; the consolidations then prevent recurrence.

- **Desktop delete-all** skips the stop-before-delete loop and the active-stream
  reselection that `ProgressStreamLifecycleController.deleteAllStreams` performs
  (`packages/desktop/src/main/desktopAgentExecution.ts:817-844`). Fixed by 01.
- **Desktop and CLI drop the `warning` severity** on follow-up notices (desktop
  calls `showInfoMessage` unconditionally at `desktopAgentExecution.ts:1110`).
  Fixed by giving the notice-to-message projection one owner.
- **Workflow auto-open** chooses a different final output on desktop
  (`outputs.at(-1)`, `desktopAgentExecution.ts:1133`) than the extension
  (`Math.max(...rounds)`, `finalOutputOpener.ts`). Pick one rule in a shared
  helper.

## Relation to existing documents

Reading order (top-down; the patterns PRD reads first even though its filename
date is later): **patterns -> decoupling -> this overview -> sub-PRDs ->
EXECUTION.** Execution/merge order is a separate axis, owned by `EXECUTION.md`.

- `ARCHITECTURE-MAP.md` - the visual companion: the couplings now (the drift) and
  the target couplings (cleaner), plus the program and execution-order diagrams.
- `docs/prds/2026-06-28-prd-architecture-patterns.md` - THE LENS: the pattern
  vocabulary and rules these PRs are expressed in (incl. the resolve-once/SSOT
  rule under Pattern 3).
- `docs/prds/2026-06-27-prd-runtime-host-decoupling.md` - THE BOUNDARY OF RECORD:
  the phased decoupling program (shipped in #6697) and audit table this continues.
- `docs/prds/2026-06-29-prd-runtime-gold-standard.md` - THE SDK CORE: the
  gold-standard target for the runtime's flow/lifecycle/injection/retry. It
  **supersedes** sub-PRD 06's `resolveRuntime*` wrapper-collapse and the
  pass-through-trim work (deleted wholesale via its PendingRequests PRD),
  **absorbs** the runtimeHost threading-reduction goal, and folds sub-PRD 04 into
  its Descriptor PRD. Its five new sub-PRDs (Retry-core, ModelCell, PendingRequests,
  RoundFlow, Descriptor) replace those slots; see its section 9.
