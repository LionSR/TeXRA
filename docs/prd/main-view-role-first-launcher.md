# PRD: Main View Launcher — Role-First Orchestrator Selection

## Status: Draft

## Supersedes

This PRD supersedes the draft `docs/prd/main-view-onboarding.md` proposed in
PR #3105.

That draft correctly identified that TeXRA's differentiator is multi-agent
orchestration, but its UI model still assumed that "orchestrator" is a single
special agent surfaced next to ordinary interactive agents.

That assumption no longer holds. TeXRA can expose multiple orchestrators, such
as `orchestrator` and `leanOrchestrator`, and will likely gain more
domain-specific leads over time. The launcher and preset UI need to treat
"orchestrator" as a role, not as one hard-coded option.

---

## Problem

The current launcher and team preset UI flatten several different concepts into
one list:

1. **Launch style** — how the session runs: orchestrated, interactive, or
   workflow.
2. **Agent role** — whether an agent is a lead orchestrator or a specialist.
3. **Concrete agent** — the actual agent selected, e.g. `orchestrator`,
   `leanOrchestrator`, `research`, or `correct`.
4. **Team preset** — a domain bundle such as Lean Project or Physicist.

This creates several UX problems:

1. **The launcher hierarchy is unclear.** Users should choose "how to work"
   first, then choose the specific lead or agent.
2. **The UI does not scale to multiple orchestrators.** A flat list works for
   one orchestrator, but becomes confusing once there are several leads.
3. **Preset cards hide the team structure.** The lead orchestrator is currently
   rendered as just another badge in the chip cloud.
4. **The data model is too weak.** A boolean like `isOrchestrator` is not
   enough to describe launcher structure, defaults, or preset relationships.
5. **The current toggle uses implementation jargon.** "Interactive" and
   "Workflow" describe system internals more than the user's decision.

---

## Design Principles

1. **Choose the role first, the concrete agent second.**
2. **Keep the top-level choice short and mutually exclusive.**
3. **Expose the lead separately from specialists everywhere a team is shown.**
4. **Do not use chips as the primary selection UI when they become dense.**
5. **Persist per-mode selections independently so switching modes is cheap.**

These principles follow common, durable UI patterns:

- A short, mutually exclusive top-level choice should use a segmented control
  or radio group.
- A second-step concrete selection should use a compact picker, not a single
  giant mixed list.
- Cards and badges should explain structure, not replace primary form controls.

---

## Goals

- Make the launcher hierarchy legible in the first five seconds.
- Support multiple orchestrators without redesigning the launcher again.
- Make team presets read as "lead orchestrator + specialists."
- Keep the launcher compact enough for a sidebar-width layout.
- Align the launcher data model with the actual product structure.

## Non-goals

- Redesigning file selectors, output management, or progress view behavior.
- Solving sign-in and auth affordances in this PRD.
- Reworking field presets into a separate "field picker" in the main view.
- Introducing a new preset editor flow; the existing Agents tab remains the
  place to define custom teams.

---

## Proposed UX

### P1 — Replace the top-level toggle with launch style selection

The launcher starts with a short single-select control:

- `Orchestrated`
- `Interactive`
- `Workflow`

This is the user's first decision. It answers "how do I want TeXRA to work?"
rather than "which implementation path should the app take?"

`Orchestrated` becomes the default first-run selection.

### P2 — Use one contextual agent picker slot, not hidden twin dropdowns

Below the launch style selector, render a single agent-picker row whose label
and options change with the selected launch style:

- `Orchestrator` when launch style is `Orchestrated`
- `Interactive agent` when launch style is `Interactive`
- `Workflow agent` when launch style is `Workflow`

This replaces the current pattern where two separate dropdowns exist in the DOM
and swap visibility.

### P3 — Treat orchestrators as a set, not a singleton

When `Orchestrated` is selected, the picker shows only orchestrator candidates,
for example:

- `orchestrator`
- `leanOrchestrator`
- future domain-specific leads

The selected orchestrator drives the inline description and the visible team
summary below the picker.

The important shift is:

- `orchestrator` is an agent
- `leanOrchestrator` is an agent
- `orchestrator` and `leanOrchestrator` both have the role `orchestrator`

### P4 — Keep specialists out of the orchestrator picker

When `Interactive` is selected, the picker shows only direct interactive
specialists, e.g.:

- `chat`
- `research`
- `review`
- `lean`

The orchestrators do not appear in this list. This prevents the launcher from
mixing "team lead" and "single interactive specialist" in one control.

### P5 — Show lead orchestrator separately in team presets

In Multi-Agent Settings, each preset card should render two distinct sections:

- `Lead orchestrator`
- `Specialists`

Example:

```text
Lean Project
Lead orchestrator
  [🎯 leanOrchestrator]
Specialists
  [lean] [leanSearch] [leanSimplifier] [review] [correct] [polish]
```

This makes the preset readable as a team structure, not a flat badge cloud.

### P6 — Show contextual inline help, not a second launcher taxonomy

The launcher should keep a compact inline hint block underneath the launch style
and agent selection area. The hint explains the selected launch style and, when
relevant, the chosen orchestrator.

The hint is explanatory copy, not a second navigation system.

---

## Launcher Mockup

### Default: Orchestrated

```text
Launch style
[ Orchestrated | Interactive | Workflow ]

Orchestrator
[ leanOrchestrator v ]

Lean orchestrator. Coordinates Lean-specific agents for theorem search,
blueprints, simplification, review, and polishing.

+------------------------------------------------------------+
| What would you like to do?                                 |
|                                                            |
| Review the proof sketch, then use Lean tools to identify   |
| missing formalization steps.                               |
+------------------------------------------------------------+

Team
[leanSearch] [leanBlueprint] [leanSimplifier] [review] [correct] [polish]

Model [ opus 4.1 v ]                                  [ Run ]
```

### Interactive

```text
Launch style
[ Orchestrated | Interactive | Workflow ]

Interactive agent
[ research v ]

Research. Stay in one conversation with a single specialist.
```

### Workflow

```text
Launch style
[ Orchestrated | Interactive | Workflow ]

Workflow agent
[ correct v ]

Correct. Runs a whole-document pass and writes revised outputs.

[ file selectors appear here ]
```

---

## Data Model

### Launcher state

Persist the user's last selection independently for each launch style:

```ts
launchStyle: 'orchestrated' | 'interactive' | 'workflow';
selectedOrchestrator: string;
selectedInteractiveAgent: string;
selectedWorkflowAgent: string;
```

This avoids losing context when switching between launch styles.

### Agent metadata

Replace the shallow boolean-centric launcher metadata with role-aware metadata.

At minimum, agent option data should distinguish:

```ts
agentRole: 'orchestrator' | 'specialist'
sessionType: 'toolUse' | 'workflow'
domains?: string[]
```

The launcher can then derive:

- orchestrated candidates = `sessionType === 'toolUse' && agentRole === 'orchestrator'`
- interactive candidates = `sessionType === 'toolUse' && agentRole === 'specialist'`
- workflow candidates = `sessionType === 'workflow'`

The old `isOrchestrator` boolean can be retained temporarily for migration, but
it should no longer be the source of truth.

### Team preset structure

Team presets should distinguish lead agents from specialists explicitly:

```ts
interface TeamPreset {
  id: string;
  name: string;
  description: string;
  leadAgentIds: string[];
  specialistAgentIds: string[];
  defaultLeadAgentId?: string;
}
```

This replaces the implicit assumption that a preset is just two flat arrays of
"tool use" and "workflow" names.

---

## Behavior Rules

1. `Orchestrated` is the default launch style for first-run users.
2. Switching launch style preserves the last selected concrete agent for that
   style.
3. Applying a team preset updates the enabled specialists and enabled lead
   orchestrators.
4. If a preset exposes exactly one lead orchestrator, the launcher auto-selects
   it.
5. If a preset exposes multiple lead orchestrators, the launcher preserves the
   current selection if still valid; otherwise it falls back to the preset's
   `defaultLeadAgentId`.
6. Workflow-only UI, especially file selectors, appears only in `Workflow`.

---

## Implementation Surface

| Concern                           | File                                                  |
| --------------------------------- | ----------------------------------------------------- |
| Launcher state schema             | `src/shared/schemas/mainView.ts`                      |
| Agent option metadata             | `src/agent/index/agentRegistry.ts`                    |
| Launcher UI and contextual picker | `src/webview/frontend/components/InstructionPanel.ts` |
| Shared option rendering           | `src/shared/utils/selectTemplates.ts`                 |
| Per-mode state restore/save       | `src/webview/frontend/MainApp.ts`                     |
| Team preset schema                | `src/shared/schemas/agentPresets.ts`                  |
| Team preset UI                    | `src/settingsView/frontend/tabs/MultiAgentTab.ts`     |

---

## Migration Notes

- Existing persisted state using `sessionType: 'toolUse'` should map to either
  `launchStyle: 'orchestrated'` or `launchStyle: 'interactive'` based on the
  selected agent's role.
- Existing users with `toolUseAgent === 'orchestrator'` migrate naturally to
  `selectedOrchestrator`.
- Existing users with a non-orchestrator tool-use agent migrate to
  `selectedInteractiveAgent`.

---

## Open Questions

- Label choice: should the first segment read `Orchestrated`, `Team`, or
  `Delegated`?
- In the sidebar, should the orchestrator picker always be a dropdown, or
  should we use selectable cards when only two or three orchestrators are
  visible?
- Should the launcher show the preset name currently supplying the selected
  orchestrator, e.g. `Lean Project`, in addition to the orchestrator name?

## Success Criteria

1. A user can tell, at a glance, the difference between orchestrated,
   interactive, and workflow launches.
2. The launcher supports multiple orchestrators without mixing them into the
   interactive specialist list.
3. Team presets visibly expose the lead orchestrator separately from
   specialists.
4. Switching launch styles preserves the user's previous concrete selection.
5. `npm run compile:fast` and `npm run typecheck` pass after implementation.
