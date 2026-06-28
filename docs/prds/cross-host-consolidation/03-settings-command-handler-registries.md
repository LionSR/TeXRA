---
created: 2026-06-28
---

# Sub-PRD 03: Shared Settings Command-Handler Registries

## Context

The progress view solved cross-host dispatch wiring with one shared factory,
`createProgressViewCommandHandlers`, consumed by both webview hosts. The settings
view never got the equivalent.

## Problem

Around 83 overlapping `SETTINGS_VIEW_COMMANDS` are hand-mapped to handler thunks
in **both** webview hosts, with no shared owner:

- Extension: `SettingsViewMessageHandler.createHandlerRegistry`
  (`packages/extension/src/settingsView/SettingsViewMessageHandler.ts:222-547`,
  ~102 keys).
- Desktop: `desktopSettingsIpc` `settingsHandlers`
  (`packages/desktop/src/main/desktopSettingsIpc.ts:1007-1184`, ~94 keys).
- Overlap is 83 commands; 19 are extension-only, 11 desktop-only (already
  drifting).

Each entry forwards to a shared settings controller, so the business logic is
single-source; the wiring table itself is reimplemented. Adding or renaming one
settings command edits two registries plus the schema. This is the single
largest cross-host change-amplification surface.

## Design

Add grouped sub-registry factories in `src/controllers/settingsView/`, mirroring
`createProgressViewCommandHandlers` but **grouped by concern, not one flat
83-callback object** (the flat shape would only relocate the Shotgun Surgery into
one mega-interface):

```ts
createSettingsMemoryHandlers(ports)
createSettingsModelHandlers(ports)
createSettingsAgentHandlers(ports)
createSettingsProfileHandlers(ports)
createSettingsGitHandlers(ports)
createSettingsLatexHandlers(ports)
```

Each returns the `{ [command]: handler }` slice for its domain, built over the
existing shared controllers. Both hosts compose the slices and add only their
host-specific entries (the 19 ext-only / 11 desk-only commands stay where they
belong, not forced into the shared set).

## Scope

- New `src/controllers/settingsView/settingsCommandHandlers/*` (grouped
  factories), built on the existing settings controllers.
- `SettingsViewMessageHandler` and `desktopSettingsIpc` compose the slices
  instead of hand-mapping the 83 shared commands.
- No schema changes; the command constants stay the SSOT.

## Acceptance

- The 83 shared command-to-handler mappings exist once, in grouped controller
  factories; each host file only lists host-specific commands plus the slice
  composition.
- Adding a shared settings command edits one factory, not two registries.
- A test proves both hosts dispatch a representative command from each group
  through the shared slice.

## Risk

- Medium. The win is real only if the factories are grouped and small. Audit the
  19/11 host-only commands first; some "host-only" entries may actually be
  shared-but-missed (a latent drift to fold in), others genuinely host-specific.
- Do not invent a generic command bus; keep per-view typed dispatch.
