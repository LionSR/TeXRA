# PRD: Main-View Onboarding — Multi-Agent Positioning

## Status: Draft

## Problem

When introducing TeXRA to faculty and students, first-time users consistently get lost at the main view. The original four pain points were:

1. **Multi-agent orchestration is the default but UI-invisible** — the orchestrator is one entry in a flat dropdown; field presets (Physicist / Math / Lean) are buried in Settings > Multi-Agent, so the product's differentiator is not legible.
2. **Core concepts aren't taught in-UI** — users don't understand "workflow vs interactive" or which agent to pick.
3. **Workflow runs read as broken** — `correct`, `polish`, `review`, `translate`, `merge` take 20–30 min and look like hangs.
4. **Setup friction is staggered** — API keys, LaTeX deps, sample project each show as separate banners.

Two of these are now partially addressed on `main`:

- **PR #3080 — Setup assistant.** `texra.runSetupAssistant` runs a conversational tool-use agent (`resources/tool_use_agents/setup.yaml` + tools under `src/tools/setup/*.ts`) that handles credential preflight, environment probing, LaTeX install, API-key setup, and sample-project creation. A `GettingStartedBanner` (`src/webview/frontend/components/GettingStartedBanner.ts`) surfaces it when no workspace files are detected, and the Getting Started walkthrough's first step launches it. Pain point #4 is addressed by a command-driven agent rather than a persistent in-webview "Let's set up TeXRA" card.
- **PR #3100 — Session hint.** `InstructionPanel.ts` renders a per-mode block (`SESSION_HINT_COPY` keyed `workflow | toolUse | orchestrator`) with `lede + body + time`. `resolveSessionHintKey` already flips to `orchestrator` via `AgentOptionData.isOrchestrator`. The `time` field for `workflow` already reads *"Typically 5–10 min on fast models, 10–30 min on frontier reasoning. Pick a smaller model if you need faster turnaround."* — pain point #3's "set the expectation" job is now done in copy, removing the need for a separate `≈ 20–30 min` badge.

What still doesn't exist on `main`:

- **No field picker** in the main view. `MainViewPersistedStateSchema` has no `field` / `teamPreset` property; field presets remain only in Settings > Multi-Agent.
- **Flat agent dropdown.** `src/shared/utils/selectTemplates.ts:renderAgentOptions()` renders one flat `<vscode-single-select>` with no `<optgroup>` / disabled-header subdivisions.
- **No pre-login affordance.** `AgentOptionDataSchema` (`src/shared/schemas/mainView.ts`) has `isOrchestrator` / `isRemote` flags but no `requiresSignIn`. The orchestrator default (`toolUseAgent.prefault('orchestrator')`) is correct, but `RemoteAgentLoader.loadRemoteAgent` throws on unauth without any pre-Execute UI cue.
- **No starter chips.** `ONBOARDING_PLACEHOLDERS` exists for the rotating placeholder but there is no clickable-chip surface.

Pain points #1 (orchestration UI-invisible) and #2 (concepts not taught at the moment of choice) remain open. This PRD scopes the remaining main-view work and explicitly leaves the setup assistant (#3080) and session hint (#3100) in place as the single sources of truth for their respective jobs.

---

## Goals

- Make TeXRA's multi-agent positioning legible in the first 5 seconds of opening the main view.
- Teach the speed/depth tradeoff between agent families *at the moment of choice*, not after Execute.
- Give unauthenticated users a frictionless, one-click path to running the orchestrator.
- Reuse existing state and education surfaces; do not introduce a second explainer or a parallel field-preset store.

## Non-goals

- **Static "Let's set up TeXRA" panel** — superseded by PR #3080's conversational setup assistant.
- **Workflow time badge / per-agent runtime estimate field** — superseded by PR #3100's `SESSION_HINT_COPY.workflow.time` copy.
- **Per-agent inline explainer** — PR #3100's per-mode hint is the single education surface; a per-agent second surface would duplicate it.
- **Walkthrough / banner rework** — `GettingStartedBanner` already handles the missing-workspace case and points to the setup assistant.

---

## Proposed changes (priority-ordered)

### P1 — Field picker (team selector) above the textarea

Pulls Physicist / Math / Lean out of Settings and into the main view as a row of pills. Below the pills, a one-line `Team: research · review · correct` lists the field's roster so the multi-agent story is concrete rather than abstract.

- **Schema** (`src/shared/schemas/mainView.ts`):
  - Extend `MainViewPersistedStateSchema` with `field: z.enum(['general', 'physicist', 'math', 'lean']).prefault('general')`.
  - Add an outbound message carrying the active field's team roster (derived from existing Multi-Agent settings) so the team line stays in sync without duplicating preset definitions.
- **Component**: new `<field-picker>` in `src/webview/frontend/components/`, mounted from `InstructionPanel.ts` directly above the textarea (and above the session hint).
- **Backend**: `MainViewMessageHandler` reads field presets from the existing Settings > Multi-Agent state — no new source of truth. Selecting a pill writes through the same setter that the settings tab uses. The picker is a shortcut into state that already exists.

### P2 — Grouped agent dropdown

Replace the flat `<vscode-single-select>` in `selectTemplates.ts:renderAgentOptions()` with two groups separated by disabled `<option>` headers. Each option is `name — one-line description`, with `description` sourced from existing `AgentOptionData.description`.

```
 ── Conversational · interactive, fast ──
   🎯 orchestrator  — Coordinates agents on your paper
      chat         — Quick Q&A with your document
      research     — Literature search and synthesis
 ── Document Processors · deep, 5–30 min ──
      correct      — Fix grammar, typos, notation
      polish       — Tighten phrasing and style
      review       — Critical review with suggestions
      translate    — Translate LaTeX preserving macros
      merge        — Combine reviewer edits into one
```

The group subtitles teach the speed/depth tradeoff at the moment of choice — the same lesson the session hint teaches *after* the choice, only earlier.

### P3 — Pre-login orchestrator affordance

Today: orchestrator is the default selection (good) but unauthenticated users only learn it's gated when Execute throws (bad).

- **Schema**: extend `AgentOptionDataSchema` with `requiresSignIn: z.boolean().optional()`.
- **Backend** (`src/webview/MainViewMessageHandler.ts:computeAgentOptionsData`): when `await SupabaseClient.isAuthenticated()` is false, (a) inject a synthetic orchestrator entry if `listRemoteAgents()` returned `[]`, (b) set `requiresSignIn: true` on it.
- **Frontend** (`InstructionPanel.ts`): when the selected agent has `requiresSignIn`, render the dropdown label as `🎯 orchestrator 🔒` and re-label Execute to `Sign in & run 🎯`. Click handler: persist `toolUseInstruction` (already in schema), fire the existing sign-in command, and re-dispatch Execute on the next `onDidChangeSessions` event. Keep the runtime guardrail in `RemoteAgentLoader.loadRemoteAgent` as the safety net.

### P4 — Starter chips on empty state (smallest, can defer)

Three clickable chips below the textarea on a first-visit empty state, seeded from existing `ONBOARDING_PLACEHOLDERS`. Chips disappear once the textarea has content. No new copy required — just a render path that picks three placeholders and turns them into buttons that fill the textarea on click.

---

## Mockups

### Steady state (signed in, orchestrator default)

```
┌─ Ask TeXRA ──────────────────────────────┐
│  [General]  Physicist  Math  Lean        │   ← P1
│  Team: research · review · correct       │   ← P1
│                                          │
│  ┌─ What would you like to do? ──────┐   │
│  └──────────────────────────────────┘    │
│  [🔬 Research] [📝 Review] [✍ Correct]   │   ← P4 (empty state only)
│                                          │
│  [🎯 orchestrator ▾] [🤖 gpt-4o ▾]  [▶] │   ← P2 (grouped)
│                                          │
│  Orchestrator. Plans a pipeline of       │   ← existing #3100 hint,
│  specialized agents and dispatches them. │     unchanged
└──────────────────────────────────────────┘
```

### Pre-login

```
┌─ Ask TeXRA ──────────────────────────────┐
│  [General]  Physicist  Math  Lean        │
│                                          │
│  ┌─ What would you like to do? ──────┐   │
│  └──────────────────────────────────┘    │
│                                          │
│  [🎯 orchestrator 🔒 ▾] [🤖 model ▾]    │   ← P3
│                      [ Sign in & run 🎯 ]│   ← P3
│                                          │
│  Orchestrator. Plans a pipeline of       │
│  specialized agents and dispatches them. │
└──────────────────────────────────────────┘
```

---

## Implementation surface

| Concern | File |
|---|---|
| Add `field` + `requiresSignIn` to schema | `src/shared/schemas/mainView.ts` |
| Picker row + lock + execute-label switch | `src/webview/frontend/components/InstructionPanel.ts` |
| New `<field-picker>` component | `src/webview/frontend/components/FieldPicker.ts` (new) |
| Grouped `<vscode-single-select>` rendering | `src/shared/utils/selectTemplates.ts` |
| `computeAgentOptionsData` + synthetic orchestrator + auth flag | `src/webview/MainViewMessageHandler.ts` |
| Source of truth for field presets (reuse, don't duplicate) | Settings > Multi-Agent state in `src/settingsView/` |
| Auth gate (read-only — already correct) | `src/agent/remote/RemoteAgentLoader.ts` |
| Re-dispatch Execute after sign-in | existing `vscode.authentication.onDidChangeSessions` hook in `src/auth/` |

## Open questions

- **Field pill labels** — `General · Physicist · Math · Lean` matches the current preset names in Settings. Should we add a pill for a user-defined "Custom" preset, or keep the picker strictly four options and leave custom teams to Settings?
- **P4 scope** — acceptable to ship P1–P3 without starter chips and defer chips to a follow-up, or do we want chips bundled in the same release to avoid a second empty-state change?
- **Orchestrator synthetic entry label** — should the unauth entry read `🎯 orchestrator 🔒` in the dropdown, or `🎯 orchestrator — sign in to use`?

## Success criteria

1. `npm run compile:fast` and `npm run typecheck` both pass.
2. **Unauthed first run**: orchestrator selected, `🔒` visible in dropdown, Execute reads `Sign in & run 🎯`. Click → VS Code sign-in completes → original prompt re-dispatches automatically (no re-typing).
3. **Field picker**: clicking each pill updates the team line under the picker, and the orchestrator's tool roster matches the chosen field (verify by inspecting dispatched agents in the Progress view).
4. **Grouped dropdown**: two disabled-header sections render in the listed order; selecting any option works as before.
5. **Empty-state chips** (if P4 shipped): blank textarea on first visit shows three chips; clicking one fills the textarea with that prompt; chips disappear once any character is typed.
6. **Workflow expectation**: run `correct` end-to-end and confirm the existing session hint copy reads naturally without an additional time badge.
