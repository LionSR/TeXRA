---
created: 2026-06-28
---

# Sub-PRD 01: Desktop Adopts the Shared progressView Controllers

## Context

The extension routes progress-board actions through host-neutral controllers in
`src/controllers/progressView/`. The desktop `DesktopProgressBridge`
(`packages/desktop/src/main/desktopAgentExecution.ts`) feeds the same shared
`createProgressViewCommandHandlers` factory but re-implements several board
sequences inline instead of calling the controllers. Desktop has therefore
drifted from the extension's behavior.

## Problem

Two board sequences are duplicated, and the desktop copies are already wrong.

- **Stream delete / delete-all.** `ProgressStreamLifecycleController`
  (`src/controllers/progressView/ProgressStreamLifecycleController.ts:40-94`)
  owns: existence guard, stop-if-in-flight, `releaseRuntimeDeletedStream(s)`,
  host cleanup, clear state, reselect the active stream, re-render. The
  extension wires it via `ProgressStreamLifecycleHost.ts:43-59`. Desktop
  re-implements it inline (`desktopAgentExecution.ts:790-844`) and skips the
  stop-if-in-flight guard, omits the `delete-all` stop-before-delete loop, and
  omits `pickValidActiveStream` reselection. Those omissions are live bugs.
- **Pending-permission view-switch tracking.** The extension's approval request
  handler tracks which streams have a pending permission; desktop keeps a
  parallel `pendingPermissionStreams` set with a comment describing it as a
  "mirror".

This is Pattern 1 Shotgun Surgery: a board behavior change must be made twice,
and the second copy lags.

## Design

Desktop implements the existing controllers' host ports rather than re-coding
the sequences:

- Route desktop `deleteStream` / `deleteAllStreams` through
  `ProgressStreamLifecycleController` by supplying a desktop
  `ProgressStreamLifecycleHost` (the file-backup, proposal, and renderer ports
  the extension already supplies). Delete the inline orchestration.
- Move the pending-permission tracking behind the same shared approval handler /
  controller the extension uses, so the "mirror" set disappears.

No new abstraction is introduced; the owners already exist. Desktop loses
orchestration code, not affordance.

## Scope

- `packages/desktop/src/main/desktopAgentExecution.ts`: replace inline
  `deleteStream` / `deleteAllStreams` and `pendingPermissionStreams` with port
  implementations + controller calls.
- Possibly small additions to the controller host-port interfaces if desktop
  needs a port the extension did not (e.g. a desktop-specific backup clear).
- No runtime command changes; no schema changes.

## Acceptance

- Desktop references `ProgressStreamLifecycleController` and no longer contains
  an inline delete-all loop or a `pendingPermissionStreams` mirror.
- A controller-level invariant test proves delete-all stops in-flight streams
  and reselects a valid active stream, exercised through both host ports.
- Behavior change is intended and noted: desktop delete-all now stops streams
  and reselects, matching the extension.

## Risk

- The desktop already feeds the shared command-handler factory, so the wiring is
  short. The only care item is desktop-specific cleanup (sidecars, IPC
  broadcast) that must remain host-owned and be passed as ports, not folded into
  the controller.
- Do NOT flatten the delivery channel (Electron IPC vs VS Code messages); only
  the orchestration moves.
