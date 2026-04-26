# PRD: Team-First Launcher and Onboarding

## Status: Draft

## Supersedes

This PRD supersedes two earlier drafts:

1. **`docs/prd/main-view-role-first-launcher.md`** (proposed in PR #3107). That
   draft correctly identified that "orchestrator" is a role, not a singleton
   agent, but its top-level model — three peer launch styles
   (Orchestrated / Interactive / Workflow) — leaves first-run users with no
   place to land before they have a credential, drops `workflowAgents` from
   the preset schema, and treats domain (Lean / Physicist / …) and launch
   style as the same axis. Reviewer comments on PR #3107 also flagged a
   missing default-lead fallback, missing migration for persisted workflow
   sessions, and migration that would mis-route non-default orchestrators
   such as `leanOrchestrator`.

2. **The launcher portion of `docs/prd/orchestrator-ui-redesign.md`**. That
   PRD's hero-textarea, inline orchestrator tip, Ctrl+Enter shortcut, and
   placeholder copy are still good and should ship; this PRD does not
   re-decide those. What it does replace is that document's Designs A/B/C/D
   for top-level mode selection — they all assumed at most one orchestrator
   and treated the launcher as a chooser between two or three modes. Once
   the team is the primary frame, the mode question disappears.

The earlier `docs/prd/main-view-onboarding.md` referenced by PR #3107 is not
present in the working tree; refer to PR #3105 for that draft.

---

## Problem

TeXRA's differentiator is multi-agent orchestration over LaTeX research
projects: a lead orchestrator coordinates a roster of specialist and workflow
agents that the user can also drive directly. The launcher today does not
make that legible.

Concretely:

1. **Multi-agent is implicit.** `orchestrator` is just one entry in the
   tool-use agent dropdown (`InstructionPanel.ts:534–595`). Whether a session
   will fan out across a team or stay one-on-one is determined by an agent
   property the user can't see — `DELEGATION_TOOLS` membership at
   `agentRegistry.ts:747`.

2. **First-run users have no anchor.** Brand-new users with zero credentials
   see the same launcher as power users, plus a "🚀 TeXRA: Get Started"
   status-bar pill (`extension.ts:108–112`) that lives outside the launcher.
   The setup story shipped in #3171/#3174 — a real conversational `setup`
   agent (`resources/tool_use_agents/setup.yaml`) with privileged tools
   including `send_to_terminal` — is hidden from the launcher because the
   agent is `internal: true`.

3. **Teams exist but read as flat badge clouds.** The Multi-Agent settings
   tab (`MultiAgentTab.ts:420–574`) ships four built-in presets
   (Mathematician, Physicist, Lean Project, Computer Scientist (ML)). Each is
   rendered as a card with a single row of agent badges — the lead
   orchestrator is not visually distinguished from specialists or workflow
   agents.

4. **Tweaking a team is a maze.** To customise a built-in team a user must
   apply the preset (which silently overwrites their global enabled-agents
   list — `agentHandlers.ts:589–592`), switch tabs to the Agents tab, toggle
   agents, click "Save Preset", then name the result. The card that triggered
   the flow has no Edit, Duplicate, or inline tweak affordance.

5. **The schema is fragile.** Custom presets reference agents by bare name,
   so renaming a custom agent silently breaks every preset that referenced
   it. Built-in presets ship without an explicit lead. Workflow defaults are
   lumped into `workflowAgents` with no role distinction.

6. **The launcher does not express intent.** Selecting `orchestrator` vs.
   `chat` looks the same in the dropdown; selecting a workflow agent
   reveals file selectors via a separate hidden div above the panel rather
   than a contextual control inside it.

The fix is to make the _team_ the primary frame — the user picks a team, and
the team determines the lead, the roster of agents the launcher surfaces, and
the workflow defaults. Setup becomes a team like any other (auto-selected for
first-run users). Specialists and workflow agents stay one click away from
the launcher even when the user is in a team that doesn't include them.

---

## Roles and vocabulary

Four roles, exposed as explicit `agentRole` metadata on every agent:

| Role             | Examples today                                                                                            | Signature                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator** | `orchestrator`, `leanOrchestrator`                                                                        | Tool-use agent that holds `delegate_agent` / `delegate_workflow` / `executions`. Plans a pipeline and dispatches other agents.                      |
| **Specialist**   | `chat`, `research`, `review`, `lean`, `numerics`, `presenter`, `latexFixer`, …                            | Tool-use agent for direct conversation. Lives inside one session.                                                                                   |
| **Workflow**     | `correct`, `polish`, `merge`, `criticize`, `apply`, `devise`, `ocr`, `transcribe_audio`, `paper2slide`, … | Single-pass agent over input files; produces one or more output files.                                                                              |
| **Setup**        | `setup`                                                                                                   | Tool-use agent with privileged installer tools (`send_to_terminal`, `set_api_key`, `probe_environment`, …). Fronts onboarding and re-configuration. |

`agentRole` replaces the `isOrchestrator` boolean derived from
`DELEGATION_TOOLS`. For a transition window it can be derived from existing
signals (`DELEGATION_TOOLS` → `orchestrator`, `internal: true` + setup tool
membership → `setup`, `AgentCategory.Workflow` → `workflow`, otherwise
`specialist`), then promoted to a first-class field on each agent's YAML.

A **team** is a named composition of agents that picks one default lead and
groups the rest by role:

- one or more **lead orchestrators** (with a required default),
- a **specialist roster** (zero or more),
- a **workflow roster** (zero or more workflow agents the team uses),
- **metadata**: name, description, icon, optional `domains` tag list,
  optional `builtIn` flag.

Teams live alongside the agent registry and are the unit the launcher
selects. The same agent can appear in any number of teams.

Vocabulary the user sees, and the codebase it replaces:

| User-visible | Replaces                                                        |
| ------------ | --------------------------------------------------------------- |
| Team         | "preset" / "agent mode preset"                                  |
| Lead         | implicit `isOrchestrator` agent in a preset                     |
| Specialist   | tool-use agent without delegation                               |
| Workflow     | workflow agent                                                  |
| Setup        | the `setup` agent + setup wizard concepts                       |
| Roster       | the launcher's contextual list of agents the active team groups |

The codebase keeps `AgentModePresetSchema` as the underlying type but renames
its display surface.

---

## Design principles

1. **The team is the primary frame.** Every session is in a team. Switching
   teams swaps the lead, the roster grouping, and the workflow defaults. It
   never silently disables global agents.
2. **Multi-agent is the default story.** The default team's default lead is
   an orchestrator. The roster strip is rendered in the launcher every
   session, so the multi-agent nature of a run is visible without the user
   touching anything.
3. **Setup is a peer.** Setup is a real team containing a real agent.
   First-run users with no credentials land in it automatically. Returning
   users can re-enter it from the team picker at any time.
4. **Built-ins are immutable.** Built-in teams cannot be edited. Tweaking
   one always produces a custom team. This is the same pattern VS Code uses
   for built-in keybindings and themes.
5. **Three levels of customization, each at the right surface.** A
   session-only override lives in the launcher roster; "save what I'm doing"
   lives in a launcher footer link; full team editing lives in the
   Multi-Agent settings tab. Each level is reachable from the previous.
6. **The agent registry is one click away.** Every agent in the system is
   reachable from the launcher's agent dropdown via grouped sections — even
   when not in the active team — without switching teams.
7. **Stable identity.** Teams reference agents by `source:name` keys, so
   renaming an agent never silently breaks a team.

## Goals

- A first-run user with zero credentials has one obvious thing to do.
- A returning user sees, at a glance, which team they're in, who the lead
  is, and what specialists and workflows are on the roster.
- Power users can run any agent solo without leaving their team, and can
  build custom teams with their own lead, roster, and workflow defaults.
- The launcher scales to N orchestrators, N specialists, N workflow agents,
  and N domains without re-architecting top-level UI.
- Teams persist correctly across upgrades, including cases where shipped
  agents are renamed or removed.

## Non-goals

- Redesigning file selectors, output management, or progress view behavior.
- Re-deciding the textarea-as-hero, Ctrl+Enter, inline orchestrator tip, or
  placeholder copy from `orchestrator-ui-redesign.md` — those still ship.
- Replacing the VS Code walkthrough (`texra.gettingStarted`). The
  walkthrough remains the canonical "manual" onboarding path; the launcher
  is the conversational one.
- Designing a sharing or marketplace flow for custom teams.

---

## Launcher UX

### Anatomy

Two stacked controls sit above the textarea: the **team picker** (top) and
the **agent picker** (below). The textarea, action buttons, model picker,
and Run button stay where `orchestrator-ui-redesign.md` puts them. A
**roster strip** is rendered below the controls and lists the agents the
active team groups, with the lead marked.

```
┌────────────────────────────────────────┐
│ [Launcher] [Progress]          [⚙] [↗]│
├────────────────────────────────────────┤
│                                        │
│  Team   [🎓 Mathematician          ▾]  │
│         7 specialists · 5 workflows    │
│                                        │
│  Agent  [🎯 orchestrator (lead)    ▾]  │
│         Plans and dispatches your team.│
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ What would you like to do?       │  │
│  │                                  │  │
│  │ (e.g. "Review my paper and       │  │
│  │ suggest improvements")           │  │
│  └──────────────────────────────────┘  │
│  [✨][🎤][🗑]    📎 Attach a file      │
│                                        │
│  [🤖 opus 4.7   ▾]            [▶ Run] │
│                                        │
│  ▾ Roster                              │
│    🎯 orchestrator           ← lead    │
│    💬 chat   🔬 research   ✓ review    │
│    ⚙ lean   🧮 simplifier              │
│    📄 correct  ✨ polish   🔄 merge    │
│                                        │
│  ▸ LaTeX Diffs                         │
└────────────────────────────────────────┘
```

The lead's description sits inline with the agent picker, so the
multi-agent nature of the default run is legible without expanding
anything.

### Team picker

Single dropdown grouped by source. Switching teams swaps the lead, the
agent dropdown's grouping, and the workflow defaults. It does **not**
clear the textarea, mutate the model selection, or alter the global
`ENABLED_AGENTS` / `ENABLED_TOOL_USE_AGENTS` workspace state.

```
  Team  [🎓 Mathematician           ▾]
        ┌────────────────────────────────┐
        │ Built-in                       │
        │  🎓 Mathematician     ← active │
        │  ⚛  Physicist                  │
        │  ⚙  Lean Project               │
        │  💻 Computer Scientist (ML)    │
        │                                │
        │ Setup & utility                │
        │  🛠 Onboarding                 │
        │                                │
        │ Custom                         │
        │  (none yet)                    │
        │  ➕ Build a new team           │
        └────────────────────────────────┘
```

### Agent picker — team-first, then everything else

The agent dropdown groups the active team's agents at the top, then surfaces
every other agent in the registry below. Picking an agent **does not**
switch teams — it replaces the agent selection for this turn. If the picked
agent is outside the active team's roster, the launcher shows a single
inline note ("Outside your team. Running solo for this turn.") and resets
to the team's default lead on the next session.

```
  Agent  [🎯 orchestrator (lead)     ▾]
         ┌──────────────────────────────┐
         │ Mathematician team           │
         │  🎯 orchestrator    ← lead   │
         │  💬 chat                     │
         │  🔬 research                 │
         │  ✓  review                   │
         │  ⚙  lean                     │
         │  🧮 simplifier               │
         │  📄 correct                  │
         │  ✨ polish                   │
         │  🔄 merge                    │
         │                              │
         │ Other orchestrators          │
         │  🎯 leanOrchestrator         │
         │                              │
         │ Other specialists            │
         │  🎨 presenter                │
         │  📐 latexFixer               │
         │  ✏️  creator                  │
         │  🔍 search                   │
         │                              │
         │ Other workflows              │
         │  📷 ocr                      │
         │  🔊 transcribe_audio         │
         │  🎓 paper2poster             │
         │  🎓 paper2slide              │
         │                              │
         │ Setup & utilities            │
         │  🛠 setup assistant          │
         │                              │
         │  ☐ Show internal/dev agents  │
         └──────────────────────────────┘
```

`getVisibleAgents` (`agentRegistry.ts:677–687`) is replaced for the launcher
by a team-aware grouping selector that returns four ordered sections:
`team`, `otherOrchestrators`, `otherSpecialists`, `otherWorkflows`,
`setup`. Each entry carries its `agentRole` so the dropdown can render
icons and the "lead" tag without re-deriving it.

### Roster strip — L1 inline tweak

The roster strip below the model row lists the active team's agents in the
order _lead → specialists → workflows_. Hovering an entry exposes a small
✕ that drops it for this turn; a final `+ Add` chip opens a quick picker
over every other agent in the registry.

```
  ▾ Roster — this turn
    🎯 orchestrator           ← lead
    💬 chat   🔬 research   ✓ review
    ⚙ lean   🧮 simplifier ✕
    📄 correct  ✨ polish   🔄 merge
    [+ Add agent]

  Modified · [Save as new team] [Reset]
```

Rules:

- Tweaks live in **session state only**. They do not persist across reload.
  The team's stored roster is unchanged. `ENABLED_AGENTS` is unchanged.
- The active team chip gets a `•` dot when modified: `🎓 Mathematician •`.
- The `Modified` footer line appears only when there is a delta. `Save as
new team` opens the L2 modal (below). `Reset` reverts to the team's
  stored roster.
- The orchestrator dispatches only over the **effective roster** for the
  turn — i.e. the team's roster plus added entries minus removed entries.
  The dispatch payload sent to the lead carries the effective roster
  explicitly so removed agents cannot be selected.
- Switching teams or picking an out-of-team agent solo discards pending
  L1 tweaks (the modified state belongs to the team that was active when
  the tweak was made; carrying it forward would be confusing).

### L2 — Save as new team

Clicking `Save as new team` in the modified footer opens a modal that is
pre-filled from the modified state. The user confirms; a custom team is
created and selected.

```
┌──────────────────────────────────────────────┐
│  Save as new team                            │
├──────────────────────────────────────────────┤
│  Name        [Mathematician (custom)      ]  │
│  Description [Mathematician without          │
│               simplifier, plus latexFixer.]  │
│  Icon        ( 🎓 ) ( ⚛ ) ( ⚙ ) ( 💻 ) ( ✨)│
│              ( 🔬 ) ( ✏️ ) ( 📐 ) ( + custom)│
│                                              │
│  Lead        [🎯 orchestrator             ▾] │
│              (1 lead in roster)              │
│                                              │
│  ☐ Set as default team for new sessions      │
│                                              │
│                       [Cancel]  [Save team]  │
└──────────────────────────────────────────────┘
```

The same modal opens for `+ Build a new team` from the team picker, with
empty fields and the active team's lead/roster pre-filled (so "build a new
team" is "duplicate this one" with one extra step).

### First-run state

When `SecretManager.anyApiKeyExists()` is `false` AND no Researcher Access
session is signed in, the launcher opens with the **Onboarding** team
selected, the **setup** agent as the lead, and a small welcome banner above
the team picker. The textarea is pre-seeded with the setup agent's opening
question so the first thing the user has to do is hit Run (or type a
clarification).

```
┌────────────────────────────────────────┐
│ ┌────────────────────────────────────┐ │
│ │ 🚀 Welcome — let's set TeXRA up.   │ │
│ │ ~3 min: env check, sign in or add  │ │
│ │ a key, open a sample paper.        │ │
│ │       [Skip · I'll do it manually] │ │
│ └────────────────────────────────────┘ │
│                                        │
│  Team   [🛠 Onboarding             ▾]  │
│         Setup assistant                │
│                                        │
│  Agent  [🛠 setup (lead)           ▾]  │
│         Walks you through environment, │
│         credentials, and your first    │
│         project.                       │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Hi — tell me what you'd like to  │  │
│  │ do with TeXRA, and whether you   │  │
│  │ already have anything installed. │  │
│  └──────────────────────────────────┘  │
│  [✨][🎤]                              │
│                                        │
│  [🤖 auto       ▾]          [▶ Start] │
│                                        │
│  ▾ Roster                              │
│    🛠 setup                  ← lead    │
│    📐 latexFixer                       │
│                                        │
│  After setup: switch to a research     │
│  team like Mathematician or Physicist. │
└────────────────────────────────────────┘
```

When the setup conversation flips the credential bit:

- the welcome banner disappears,
- the team picker auto-promotes to an **intent-derived** default — derived
  from what the user told the setup agent (Lean Project if Lean was
  mentioned, Physicist if numerics were mentioned, otherwise Mathematician),
- the previous Onboarding state is preserved — re-selecting Onboarding from
  the team picker works at any time, including for re-running setup after
  upgrades.

The `texra.gettingStarted` walkthrough and the "🚀 TeXRA: Get Started"
status-bar pill (`extension.ts:108–112`) are unchanged. They remain the
canonical entry points for users who close the launcher; clicking either
selects the Onboarding team and opens the launcher.

### Out-of-team specialist or workflow run

Picking an agent outside the active team's roster runs the agent solo for
the turn without changing teams. The launcher shows a single inline note
and the team chip remains stable.

```
  Team   [🎓 Mathematician          ▾]
  Agent  [🎨 presenter              ▾]
         Builds a LaTeX Beamer deck
         from your paper.
         ⓘ Outside your team.
           Running solo for this turn.
```

The next session restores the team's default lead. This preserves the
"team is your home" mental model while keeping every specialist and
workflow agent one click away from the launcher.

---

## Settings — Multi-Agent tab

The Multi-Agent tab is the home of the team registry. It groups teams by
source (Built-in, Setup & utility, Custom) and surfaces explicit
Use / Edit / Duplicate / Delete actions so the Agents-tab-and-back-again
dance disappears.

### Team grid

```
┌──────────────────────────────────────────────────────────────────────┐
│ Multi-Agent Teams                                                    │
│ Pick a team to lead your sessions. Custom teams can be edited;       │
│ built-in teams are read-only — duplicate one to customize it.        │
│                                                                      │
│ Built-in                                                             │
│ ┌──────────────────────────┐ ┌──────────────────────────┐            │
│ │ 🎓 Mathematician  ✓Active│ │ ⚛  Physicist             │            │
│ │ Lean-aware proof + paper │ │ Numerics + research +    │            │
│ │ workflow.                │ │ Wolfram-driven derivation│            │
│ │                          │ │                          │            │
│ │ Lead: 🎯 orchestrator    │ │ Lead: 🎯 orchestrator    │            │
│ │ Specialists: chat,       │ │ Specialists: research,   │            │
│ │  research, review, lean, │ │  numerics, review,       │            │
│ │  simplifier              │ │  search, presenter,      │            │
│ │ Workflows: correct,      │ │  simplifier             │            │
│ │  polish, merge, devise,  │ │ Workflows: criticize,    │            │
│ │  apply                   │ │  generic, devise, apply  │            │
│ │                          │ │                          │            │
│ │  [Use]  [Duplicate]      │ │  [Use]  [Duplicate]      │            │
│ └──────────────────────────┘ └──────────────────────────┘            │
│ ┌──────────────────────────┐ ┌──────────────────────────┐            │
│ │ ⚙ Lean Project           │ │ 💻 Computer Scientist (ML)│           │
│ │ Lean 4 formalization     │ │ ML/CS research workflow. │            │
│ │ workflow.                │ │                          │            │
│ │ Lead: 🎯 leanOrchestrator│ │ Lead: 🎯 orchestrator    │            │
│ │ Specialists: lean,       │ │ Specialists: numerics,   │            │
│ │  leanSearch, leanBlue-   │ │  search, review, present │            │
│ │  print, leanSimplifier,  │ │  simplifier, latexFixer, │            │
│ │  latexFixer, progress-   │ │  progressCheck           │            │
│ │  Check                   │ │ Workflows: criticize,    │            │
│ │ Workflows: (none)        │ │  generic, devise, apply, │            │
│ │  [Use]  [Duplicate]      │ │  polish                  │            │
│ │                          │ │  [Use]  [Duplicate]      │            │
│ └──────────────────────────┘ └──────────────────────────┘            │
│                                                                      │
│ Setup & utility                                                      │
│ ┌──────────────────────────┐                                         │
│ │ 🛠 Onboarding             │                                         │
│ │ Setup assistant and      │                                         │
│ │ basic LaTeX repair.      │                                         │
│ │ Lead: 🛠 setup           │                                         │
│ │ Specialists: latexFixer  │                                         │
│ │  [Use]  [Duplicate]      │                                         │
│ └──────────────────────────┘                                         │
│                                                                      │
│ Custom              [+ New team]   [+ Save current launcher state]   │
│ ┌──────────────────────────┐                                         │
│ │ 🎓 Number Theory         │                                         │
│ │ My team for analytic NT. │                                         │
│ │ Lead: 🎯 orchestrator    │                                         │
│ │ Specialists: research,   │                                         │
│ │  review, lean, leanSearch│                                         │
│ │ Workflows: polish, merge │                                         │
│ │  [Use] [Edit] [Delete]   │                                         │
│ └──────────────────────────┘                                         │
│                                                                      │
│ ─── Team Coordination ───                                            │
│ ☑ Auto-approve subagent steps                                        │
│ ☑ Detach subagents on completion                                     │
│ ☑ Worktree support for multi-agent runs                              │
│ ☐ Allow orchestrator kill-switch                                     │
│ Max delegation depth   [────●────] 3                                 │
└──────────────────────────────────────────────────────────────────────┘
```

Card differences vs. the current `MultiAgentTab.ts:420–574`:

- Three explicit sub-rows on each card — **Lead**, **Specialists**,
  **Workflows** — replacing the flat badge cloud. The lead is the only
  agent rendered with the 🎯 prefix and the literal "Lead:" label.
- **Use / Edit / Duplicate / Delete** action row. Built-in cards expose
  Use + Duplicate. Setup & utility cards expose Use + Duplicate. Custom
  cards expose Use + Edit + Delete.
- The "✓ Active" badge moves to the card header next to the team name
  rather than overlapping the title.
- The icon is rendered larger and to the left of the team name so the
  icon and the team name read as one unit.

### Built-in immutability + Duplicate

`Duplicate` on a built-in card creates a custom team named
`{built-in name} (copy)` with the same lead, roster, icon, and description,
then immediately opens the team editor. This is the _only_ legal path to
"customise Mathematician" — the built-in itself is never mutated. The
schema enforces this: `builtIn: true` records cannot be written through
any handler.

### Team editor

Opens for **Edit** (custom), **Duplicate** (any), and **+ New team**. Same
panel in all three cases; difference is only the prefilled values.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Edit team — Number Theory                            [Save] [Cancel]│
├──────────────────────────────────────────────────────────────────────┤
│  Name        [Number Theory                            ]             │
│  Description [My team for analytic NT.                 ]             │
│  Icon        🎓                                                      │
│  Domains     [number-theory] [analytic] [+ Add]                      │
│                                                                      │
│  Lead orchestrators                                                  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ☑ 🎯 orchestrator                  ● default                  │  │
│  │  ☐ 🎯 leanOrchestrator              ○ default                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Specialists                                                         │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ☑ 💬 chat       ☑ 🔬 research  ☑ ✓ review                    │  │
│  │  ☑ ⚙ lean        ☑ 🔍 leanSearch ☐ 🧮 simplifier              │  │
│  │  ☐ 🎨 presenter  ☐ 📐 latexFixer ☐ 🔢 numerics                │  │
│  │  ...                                                          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Workflows                                                           │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ☐ 📄 correct   ☑ ✨ polish    ☑ 🔄 merge                     │  │
│  │  ☐ 📷 ocr       ☐ 🔊 transcribe ☐ 🎓 paper2slide              │  │
│  │  ...                                                          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Showing only enabled agents from the Agents tab.                    │
│  [Manage agents →]                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

Editor rules:

1. The lead orchestrators section lists every agent with
   `agentRole === 'orchestrator'`. At least one must be checked. The radio
   in the `default` column picks `defaultLeadAgentId`. If only one lead is
   checked it is the default automatically; if more than one is checked
   the user must pick one explicitly (Save is disabled otherwise — closes
   the PR #3107 P2 hole).
2. The specialists and workflows sections list agents with
   `agentRole === 'specialist'` and `agentRole === 'workflow'` respectively.
3. Setup-role agents do not appear in any team editor by default. They are
   only included in the built-in `Onboarding` team and any custom team that
   explicitly opts in (a power-user toggle, off by default).
4. The agent lists are filtered to **only enabled agents from the Agents
   tab**. A small footnote explains this; `Manage agents →` deep-links to
   the Agents tab. Disabling an agent there grays it out here on next
   render but does not silently remove it from team storage (see the
   schema's stable-key rule).

### "+ Save current launcher state"

A button at the top of the Custom group is the explicit handoff from the
launcher. Clicking it opens the same team editor with the launcher's
current effective roster prefilled — same as L2's `Save as new team`,
just initiated from settings instead of from the launcher footer.

### Team Coordination section

Unchanged from today (auto-approve subagent steps, detach subagents,
worktree support, kill-switch, max delegation depth). The section moves
below the team grid and stays a sibling — these are global delegation
behaviours, not per-team. A future PRD can move them per-team if needed.

### What `Use` does

`Use` selects the team in the launcher and dismisses the settings view.
It does **not** mutate `ENABLED_AGENTS` or `ENABLED_TOOL_USE_AGENTS` —
unlike today's `handleApplyAgentModePreset` (`agentHandlers.ts:589–592`),
which overwrites both lists wholesale. This decoupling is the most
behaviour-affecting change in this PRD; it eliminates the silent-disable
footgun and makes the global enabled-agents set act as the _available
pool_, with teams as curated _views_ on top of it.

---

## Settings — Agents tab

The Agents tab keeps its job as the agent registry browser (atoms): enable,
disable, customize YAML, create new. It loses the team-creation
responsibilities, which now live in the launcher and the Multi-Agent tab.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Agents                                                               │
│  [Workflow (12)] [Tool Use (15)]                                     │
│  Custom dir: ~/.texra/agents      [Open] [Change] [Reset]            │
│  [+ New agent] [+ From template]                                     │
├─────────────────┬────────────────────────────────────────────────────┤
│ Custom (3)      │  🎯 orchestrator                Built-in · Tool Use│
│ ☑ myReviewer    │                                Role: Lead          │
│ ☑ leanProver    │                                                    │
│ ☐ scratch       │  Coordinates multi-agent work on LaTeX research    │
│                 │  projects. Plans, delegates, monitors, reports.    │
│ Remote (2)      │                                                    │
│ ☑ search        │  Used by teams 🎓 Mathematician · ⚛ Physicist     │
│ ☑ progressCheck │                · 💻 Computer Scientist (ML)        │
│                 │                                                    │
│ Built-in (15)   │  Tools: delegate_agent, delegate_workflow,         │
│ ☑ 🎯 orchestrat.│         executions, plan, todo_write, ...          │
│ ☑ 🎯 leanOrch.. │                                                    │
│ ☑ 💬 chat       │  [Open YAML] [Customize] [Reveal]                  │
│ ☑ 🔬 research   │                                                    │
│ ☑ ✓ review      │                                                    │
│ ☑ ⚙ lean        │                                                    │
│ ☑ 🛠 setup    🔒│                                                    │
│ ...             │                                                    │
└─────────────────┴────────────────────────────────────────────────────┘
```

### Concrete deltas vs. today

1. **`Save Preset` toolbar button removed.** Today's flow (toggle agents
   here, click `Save Preset`, name in a `vscode.window.showInputBox`) lives
   in `AgentsTab.ts:225–227` and `agentHandlers.ts:609–652`. It is replaced
   by the launcher's `Save as new team` (L2) and the Multi-Agent tab's
   `+ Save current launcher state` / `+ New team`. The Agents tab is no
   longer the entry point for creating a team.
2. **Role badge** on every agent list item and the detail pane: `Lead`,
   `Specialist`, `Workflow`, `Setup`. Derived from `agentRole`.
3. **"Used by teams" line** in the detail pane lists every team — built-in
   and custom — that references the selected agent. This is the
   counterpart of the team editor's view: from the agent side, the user
   can see _which teams will be affected_ before disabling an agent or
   customizing its YAML.
4. **Setup agents are visible-but-locked.** Today `setup` is `internal:
true` and hidden entirely. The Agents tab now shows it with a 🔒 icon,
   role badge `Setup`, and a disabled toggle. The detail pane explains
   why: _"Setup agents are managed by the Onboarding team and cannot be
   disabled. Open YAML to inspect."_ The "Open YAML" affordance still
   works so power users can read the agent's prompt.
5. **Disable confirmation when an agent is in a team.** Toggling off an
   agent that is in any team — built-in or custom — shows a non-blocking
   confirmation listing the affected teams: _"`research` is used by
   'Number Theory' (custom) and Mathematician. Disable anyway? Affected
   teams will run without it."_ No silent breakage.
6. **The agent detail pane keeps `[Open YAML] [Customize] [Reveal]`** as
   today. `Customize` continues to copy the YAML to the user's custom
   agents folder and open the copy (`agentHandlers.ts:371–456`).

### What "enabled" means after this PRD

Today, enabling an agent has two effects: it shows up in the launcher's
agent dropdown, and it can be referenced by a preset apply (which
overwrites enabled state). After this PRD, enabling an agent has one
effect: it is part of the _available pool_ of agents the team editor and
launcher dropdown can pull from. Teams reference agents by stable
`source:name` keys regardless of enabled state, but they only render
checked-by-default in the team editor when enabled. This is what the team
editor's footnote ("Showing only enabled agents from the Agents tab")
means.

---

## Data model

### Agent metadata

```ts
type AgentRole = 'orchestrator' | 'specialist' | 'workflow' | 'setup';
type AgentSource = 'builtInToolUse' | 'builtInWorkflow' | 'remote' | 'custom';
type AgentRef = `${AgentSource}:${string}`;

interface AgentEntry {
  // existing fields preserved
  name: string;
  source: AgentSource;
  path: string;
  description?: string;
  tools?: string[];
  internal?: boolean;
  multiplePath?: string;
  isMultiple?: boolean;
  visibility?: string[];

  // existing category kept for backwards compat in storage
  category: AgentCategory; // 'workflow' | 'toolUse'

  // new
  agentRole: AgentRole; // explicit, not derived
  domains?: string[]; // optional tags: 'lean', 'physics', ...

  // derived helpers
  ref(): AgentRef; // `${source}:${name}`
}
```

`agentRole` is a YAML field on every agent definition. For built-in YAMLs in
`resources/agents/` and `resources/tool_use_agents/`, we add the field
explicitly. For agents that don't yet declare it, the registry derives it
on load with a strict precedence:

1. `internal === true` AND tools include `send_to_terminal` OR `set_api_key`
   → `setup`
2. tools include `delegate_agent` OR `delegate_workflow` OR `executions`
   → `orchestrator`
3. `category === 'workflow'` → `workflow`
4. otherwise → `specialist`

The derived value is exposed alongside the YAML field and emits a one-time
console warning so we can audit which built-ins still need explicit
declarations.

### Team schema

Replaces `AgentModePresetSchema` in
`src/shared/schemas/agentPresets.ts`. The Zod schema mirrors:

```ts
const AgentRefSchema = z
  .string()
  .regex(/^(builtInToolUse|builtInWorkflow|remote|custom):.+$/);

const TeamSchema = z.object({
  id: z.string(), // 'mathematician' | 'custom-…'
  name: z.string().min(1),
  description: z.string(),
  icon: z.string(), // codicon name or emoji
  builtIn: z.boolean().prefault(false),
  domains: z.array(z.string()).prefault([]),

  leadAgentIds: z.array(AgentRefSchema).min(1),
  defaultLeadAgentId: AgentRefSchema, // REQUIRED, ∈ leadAgentIds
  specialistAgentIds: z.array(AgentRefSchema).prefault([]),
  workflowAgentIds: z.array(AgentRefSchema).prefault([]),
});
```

The `defaultLeadAgentId` is required even when there is exactly one lead.
Validation rejects records where `defaultLeadAgentId ∉ leadAgentIds`. This
is the closure of PR #3107's reviewer P2.

### Launcher state

`MainViewPersistedStateSchema` (`src/shared/schemas/mainView.ts`) gains:

```ts
selectedTeamId: string; // default 'mathematician'
selectedAgentId: AgentRef; // resolved on load to
//   active team's defaultLead
//   if no longer valid
```

Session state — not persisted — gains:

```ts
sessionTeamOverride?: {
  baseTeamId: string;
  added: AgentRef[];
  removed: AgentRef[];
};
```

The launcher computes the _effective roster_ per render as
`(team.lead ∪ specialists ∪ workflows ∪ override.added) \ override.removed`.

The current launcher state schema's `sessionType` field is dropped from the
launcher's first-class state. The session type for a run is derived from the
selected agent's `agentRole`:

| selected agentRole | run kind                                       |
| ------------------ | ---------------------------------------------- |
| `orchestrator`     | tool-use, multi-agent                          |
| `specialist`       | tool-use, single-agent                         |
| `workflow`         | workflow                                       |
| `setup`            | tool-use, single-agent (with privileged tools) |

For backwards compatibility, the persisted `sessionType` remains writable in
storage during the migration window so older builds reading the same
workspace state don't crash; it is just no longer the source of truth in the
launcher render path.

### Built-in teams

Shipped as `builtIn: true` records in code, not in workspace state:

| id              | name                    | icon | lead               | specialists                                                                                          | workflows                                           |
| --------------- | ----------------------- | ---- | ------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `mathematician` | Mathematician           | 🎓   | `orchestrator`     | `chat`, `research`, `review`, `lean`, `simplifier`, `latexFixer`, `progressCheck`                    | `correct`, `polish`, `merge`, `devise`, `apply`     |
| `physicist`     | Physicist               | ⚛    | `orchestrator`     | `research`, `numerics`, `review`, `search`, `presenter`, `simplifier`, `latexFixer`, `progressCheck` | `criticize`, `generic`, `devise`, `apply`           |
| `lean-project`  | Lean Project            | ⚙    | `leanOrchestrator` | `lean`, `leanSearch`, `leanBlueprint`, `leanSimplifier`, `latexFixer`, `progressCheck`               | (none)                                              |
| `cs-ml`         | Computer Scientist (ML) | 💻   | `orchestrator`     | `numerics`, `search`, `review`, `presenter`, `simplifier`, `latexFixer`, `progressCheck`             | `criticize`, `generic`, `devise`, `apply`, `polish` |
| `onboarding`    | Onboarding              | 🛠   | `setup`            | `latexFixer`                                                                                         | (none)                                              |

Each id is stable across upgrades; renaming a built-in team requires a
migration entry that maps the old id to the new one.

---

## Behaviour rules

1. **Default team for new users.** First boot with no persisted launcher
   state and no credential present → `selectedTeamId = 'onboarding'`,
   `selectedAgentId = 'builtInToolUse:setup'`. Welcome banner rendered.
2. **Default team for new users with credential present.** First boot with
   no persisted launcher state and a credential present →
   `selectedTeamId = 'mathematician'`, agent = team's defaultLead.
3. **Restore on reopen.** If the persisted `selectedTeamId` resolves to an
   existing team, restore it. If not (team deleted) fall back to
   `mathematician`. If the persisted `selectedAgentId` is not in the
   restored team's roster and not a global agent, fall back to the team's
   `defaultLeadAgentId`.
4. **Switch team rule.** Switching teams clears any L1 session override,
   sets `selectedAgentId` to the new team's `defaultLeadAgentId`, and
   leaves textarea, model, and file selectors untouched.
5. **Out-of-team agent rule.** Picking an agent that is not in the active
   team's roster does not change `selectedTeamId`, but sets a transient
   "running solo" flag for the inline note. The next session restores
   `selectedAgentId` to the team's `defaultLeadAgentId`.
6. **L1 override semantics.** Adds and removes are session-only. Switching
   teams or deleting/applying a team discards them. `Reset` clears them.
   `Save as new team` consumes them into a new team and clears them.
7. **Apply team rule.** `Use` from the Multi-Agent tab and `+ Build a new
team` after Save in the launcher both call the same internal selector;
   neither mutates `WorkspaceStateKey.ENABLED_AGENTS` or
   `ENABLED_TOOL_USE_AGENTS`. The wholesale-overwrite path in
   `handleApplyAgentModePreset` (`agentHandlers.ts:589–592`) is removed.
8. **Default lead rule.** Saving or editing a team requires
   `defaultLeadAgentId` to be set and ∈ `leadAgentIds`. Save is disabled
   in the editor when this is not satisfied.
9. **Setup team auto-promotion.** When the setup agent calls
   `verify_setup` and reports a usable credential present, the launcher
   posts a follow-up notice: _"You're set. Switch to a research team like
   Mathematician or Physicist?"_ Accepting selects that team and seeds the
   textarea empty; declining keeps the user in Onboarding.
10. **Built-in team immutability.** `Edit` is hidden on built-in cards.
    Any handler that receives a write request for a `builtIn: true` team
    rejects it.
11. **Disabling an agent in a team.** Disabling an agent that is in any
    team requires confirmation (described in the Agents tab section).
    Disabled agents are kept in team storage and appear unchecked-and-grey
    in the team editor — re-enabling restores the team to working order
    without re-saving.

---

## Migration

The launcher reads four shapes today. The migration is fail-soft for each
and emits one consolidated toast on first launch after upgrade if anything
needed repair: _"Updated N teams to the new schema. See Settings → Multi-
Agent."_.

### Built-in presets in code

`AGENT_MODE_PRESETS` (`src/shared/schemas/agentPresets.ts:30–102`) is
rewritten to the new `Team[]` schema with explicit lead/default/spec/wf
splits — see the table above. No persistent state involved; this is
shipped code.

### Custom presets in workspace state

Today's `WorkspaceStateKey.CUSTOM_AGENT_PRESETS` is
`Array<AgentModePreset>` with `workflowAgents: string[]`,
`toolUseAgents: string[]`. Migration runs at first read in
`handleGetCustomPresets`-equivalent path:

| Old field                  | New field                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `id` (unchanged)                                                                                                                                                                                                                                                                                                                            |
| `name`                     | `name` (unchanged)                                                                                                                                                                                                                                                                                                                          |
| `description`              | `description` (unchanged)                                                                                                                                                                                                                                                                                                                   |
| `icon`                     | `icon` (unchanged)                                                                                                                                                                                                                                                                                                                          |
| `toolUseAgents: string[]`  | resolve each name through `agentRegistry` to its source. Agents with `agentRole === 'orchestrator'` go to `leadAgentIds`. Other tool-use agents go to `specialistAgentIds`. Setup agents are dropped (with a one-time toast). Unresolved names are kept as `builtInToolUse:<name>` and surface in the team editor as red "missing" entries. |
| `workflowAgents: string[]` | resolve each name through `agentRegistry` → `workflowAgentIds`. Restores the field that PR #3107 dropped (closes PR #3107 reviewer P1 on `agentPresets.ts`).                                                                                                                                                                                |
| (new) `leadAgentIds`       | populated above                                                                                                                                                                                                                                                                                                                             |
| (new) `defaultLeadAgentId` | first entry of `leadAgentIds`. If none (a preset that contained no orchestrator), the migration adds `builtInToolUse:orchestrator` as the default lead and surfaces a per-preset toast.                                                                                                                                                     |
| (new) `builtIn`            | `false`                                                                                                                                                                                                                                                                                                                                     |

### Persisted launcher state in workspace state

Today's `MainViewPersistedState` may include `sessionType` and a chosen
agent. Migration:

| Persisted today                                                | Maps to                                                                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessionType: 'toolUse'`, `toolUseAgent: 'orchestrator'`       | `selectedTeamId: 'mathematician'`, `selectedAgentId: 'builtInToolUse:orchestrator'`                                                                                                              |
| `sessionType: 'toolUse'`, `toolUseAgent: 'leanOrchestrator'`   | `selectedTeamId: 'lean-project'`, `selectedAgentId: 'builtInToolUse:leanOrchestrator'`                                                                                                           |
| `sessionType: 'toolUse'`, `toolUseAgent: <other orchestrator>` | `selectedTeamId: 'mathematician'`, `selectedAgentId: <ref of that orchestrator>` (out-of-team solo on first render). Closes PR #3107 reviewer P1 on migration.                                   |
| `sessionType: 'toolUse'`, `toolUseAgent: <specialist>`         | `selectedTeamId: 'mathematician'`, `selectedAgentId: <ref>` (in-roster if Mathematician includes it; else solo)                                                                                  |
| `sessionType: 'workflow'`, `workflowAgent: <name>`             | `selectedTeamId: 'mathematician'`, `selectedAgentId: <ref of workflow agent>` (in-roster if Mathematician's workflows include it; else solo). Closes PR #3107 reviewer P2 on workflow migration. |
| no persisted launcher state, no credential                     | `selectedTeamId: 'onboarding'`, `selectedAgentId: 'builtInToolUse:setup'`                                                                                                                        |
| no persisted launcher state, credential present                | `selectedTeamId: 'mathematician'`, `selectedAgentId: 'builtInToolUse:orchestrator'`                                                                                                              |

The persisted `sessionType` and `*Agent` fields are kept in storage during
one minor-version migration window so a downgrade does not lose the user's
last selection. They are written by the launcher's `selectedAgentId →
sessionType` derivation on every session change.

### Global enabled-agents state

`WorkspaceStateKey.ENABLED_AGENTS` and `ENABLED_TOOL_USE_AGENTS` are
unchanged in shape and content. The semantic change is that they are no
longer overwritten by team apply. Migration is a no-op; behaviour change
is documented in the v0.x.0 changelog as: _"Switching multi-agent teams no
longer disables agents you had enabled. Teams are now a view on top of
your enabled agents."_

---

## Implementation surface

| Concern                                                    | File                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `agentRole` field on agent YAMLs                           | `resources/agents/*.yaml`, `resources/tool_use_agents/*.yaml`, `reference-agents/**/*.yaml` |
| `agentRole` derivation + `AgentEntry.ref()`                | `src/agent/index/agentRegistry.ts`                                                          |
| Team schema, built-in records, migration                   | `src/shared/schemas/agentPresets.ts`                                                        |
| Custom team CRUD handlers                                  | `src/settingsView/handlers/agentHandlers.ts`                                                |
| Multi-Agent tab grid + team editor                         | `src/settingsView/frontend/tabs/MultiAgentTab.ts`                                           |
| Agents tab role badges, "Used by teams", setup-locked rows | `src/settingsView/frontend/tabs/AgentsTab.ts`, `AgentSelectionPanel.ts`                     |
| Launcher team picker + agent grouped picker                | `src/webview/frontend/components/InstructionPanel.ts`                                       |
| Grouped option rendering (team-aware)                      | `src/shared/utils/selectTemplates.ts`                                                       |
| Launcher persisted state + session override                | `src/shared/schemas/mainView.ts`, `src/webview/frontend/MainApp.ts`                         |
| First-run team selection + welcome banner                  | `src/webview/frontend/MainApp.ts`, `src/commands/setup/setupAssistantCommand.ts`            |
| Setup auto-promotion follow-up                             | `src/commands/setup/setupAssistantCommand.ts`                                               |
| Effective-roster dispatch payload to lead                  | `src/agent/runtime/` (lead receives `effectiveRoster: AgentRef[]` in its delegate context)  |
| Status-bar pill (unchanged)                                | `src/extension.ts:108–112`                                                                  |
| Walkthrough (unchanged)                                    | `package.json` `contributes.walkthroughs.texra.gettingStarted`                              |

### Implementation order

1. **Add `agentRole` derivation** on `AgentEntry` without changing UI. Audit
   the registry against the four expected role buckets. Add the field to
   built-in YAMLs as a follow-up cleanup.
2. **Add `Team` schema + migration** for built-in and custom presets, with
   the new launcher fields stubbed but not yet rendered.
3. **Refactor `handleApplyAgentModePreset`** to _select_ a team rather
   than overwrite `ENABLED_AGENTS`. Behind a feature flag for one minor
   version — when disabled, fall back to today's wholesale overwrite.
4. **Render the new launcher controls** (team picker, grouped agent picker,
   roster strip, modified footer) behind the same feature flag.
5. **Render the new Multi-Agent tab** (Use/Edit/Duplicate/Delete actions,
   team editor side panel) behind the same flag.
6. **Refresh the Agents tab** (role badges, "Used by teams", visible-but-
   locked setup agents, removed `Save Preset` button).
7. **First-run rule** (Onboarding team auto-selected, welcome banner,
   setup auto-promotion) once the launcher renders teams.
8. **Flip the flag** in a single release once the migration paths are
   verified against held-out fixtures of all four persisted shapes.

A small migration-fixture suite (`src/shared/schemas/__fixtures__/`) holds
serialized snapshots of each persisted shape: built-in-only, custom with
orchestrator, custom without orchestrator, persisted launcher with each
sessionType variant, no-credential first launch. Migration tests assert
each fixture produces a valid `Team[]` and `MainViewPersistedState`.

---

## Success criteria

1. A new user with no credentials lands in the Onboarding team and is
   conversing with the setup agent within five seconds of opening the
   launcher.
2. A returning user opens the launcher and can name, in one sentence, what
   team they're in, who the lead is, and what other agents are on the
   roster.
3. A power user can run any specialist or workflow agent without leaving
   their team, by picking it from the agent dropdown's "Other" sections.
4. A user who has tweaked the active team's roster for a session can save
   the result as a new custom team without leaving the launcher.
5. A user who switches teams keeps their globally enabled agents
   undisturbed; switching back to the previous team produces the same
   roster.
6. Existing users upgrading from a pre-PRD build retain their last
   orchestrator/specialist/workflow selection (covered by all rows in the
   migration table).
7. The launcher renders correctly when a third orchestrator is added to
   the registry (no top-level UI change required to surface it).
8. `npm run compile:fast` and `npm run typecheck` pass.

---

## Non-goals (restated)

- Textarea-as-hero, Ctrl+Enter, inline orchestrator tip, smooth file-panel
  collapse, placeholder copy revision — these belong to
  `docs/prd/orchestrator-ui-redesign.md` and ship independently.
- Replacing the `texra.gettingStarted` walkthrough.
- Sharing or marketplace flows for custom teams.
- Per-team overrides of Team Coordination toggles (auto-approve, kill
  switch, max delegation depth).
- A field-picker UI separate from teams (domains are first-class on a team
  but not a navigable axis).

---

## Open questions

1. **Where does the team chip live once the launcher gets a more compact
   layout?** Two options: (a) above the agent picker as drawn here, or
   (b) inline with the launcher's tab bar (next to `[Launcher]
[Progress]`). Option (b) saves a row but couples the launcher's chrome
   to team state. Recommend (a) until the launcher itself is refactored.
2. **Should the active team appear as a status-bar item?** A small
   `🎓 Mathematician` pill in the VS Code status bar would let users
   confirm their team without opening the launcher and would let us drop
   the team chip from the launcher header in a future compact layout. Out
   of scope for this PRD; revisit after launcher v1.
3. **Should `agentRole === 'setup'` agents be allowed in non-Onboarding
   teams?** Today's design hides them from the team editor by default.
   The opt-in toggle gives power users an escape hatch, but a custom team
   with a setup agent + privileged terminal access has a real security
   surface. Recommend keeping the opt-in toggle dimmed and behind a
   confirmation until we've reviewed the full surface.
