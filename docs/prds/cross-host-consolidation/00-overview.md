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

A user action should flow through three hops, not four: host adapter, runtime
command, runtime internals. Where a sequence appears in two hosts, it has a
missing owner. Where a host re-implements a controller the other host already
calls, the host has skipped the seam and will drift. The work here closes those
gaps; it does not flatten genuine host affordances (shells, IPC vs webview vs
Ink delivery, CLI-only in-run controls).

## The sub-PRDs

| # | Sub-PRD | Owner it lands in | Amp |
| - | ------- | ----------------- | --- |
| 01 | Desktop adopts the shared progressView controllers (delete, pending-permission) | `src/controllers/progressView/*` (existing) | High |
| 02 | One `requestRuntimeStreamResume` command (snapshot/auto-resume) | `src/agent/runtime/resumeCommands.ts` | High |
| 03 | `createSettingsViewCommandHandlers` grouped sub-registries | `src/controllers/settingsView/*` (new) | High |
| 04 | Agent identity: resolve-once, carry the resolved name | `src/agent/runtime/AgentLaunchContext.ts` | Medium |
| 05 | External-inquiry resolution policy into `humanInputCommands` | `src/agent/runtime/humanInputCommands.ts` | Medium |
| 06 | Reduce the `resolve*` method surface (165 names, overloaded verb) | `runCoordinatorCommands` + naming convention | Low-Med |
| 07 | UI as a pure reactive projection of the runtime (one store, hosts derive) | `src/shared/progressView/backend` (generalize) | Medium-High |

## Priority order

Lowest-risk highest-leverage first:

1. **Drift-bug fixes** (below) - they are bugs, independent of any refactor.
2. **Sub-PRD 01** - desktop adopts the existing controllers. Collapses the most
   duplication and removes the drift class at its source.
3. **Sub-PRD 03** - the settings registry is the single largest surface.
4. **Sub-PRD 02 / 05** - the two remaining unshared sequences.
5. **Sub-PRD 04** - the identity resolve-once cleanup.
6. **Sub-PRD 06** - the `resolve*` verb convergence, mostly opportunistic.

Sub-PRD 07 is the unifying frame: it views the same desktop fault from the store
side and makes every host a pure reactive projection of one shared store. It
depends on 01 (and the drift-bug fixes) landing first, and it does not re-claim
01's deletions. Its honest scope is roughly half its first-draft promise: the
record-store delta patch type does not exist yet and must ship before the
frontend mirror reducer can be deleted, so treat 07 as the medium-term direction,
not a quick win.

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

- `docs/prds/2026-06-28-prd-architecture-patterns.md` - the pattern vocabulary
  and rules these PRs are expressed in.
- `docs/prds/2026-06-27-prd-runtime-host-decoupling.md` - the phased decoupling
  program and audit table this continues.
