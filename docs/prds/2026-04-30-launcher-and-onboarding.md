---
created: 2026-04-30
updated: 2026-06-13
---

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

2. **The launcher portion of `docs/prds/2026-04-13-orchestrator-ui-redesign.md`**. That
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
   tab (`MultiAgentTab.ts`) ships five built-in teams
   (Mathematician, Physicist, Lean Project, Computer Scientist, and
   Software Engineer). Each is
   rendered as a card with a single row of agent badges — the lead
   orchestrator is not visually distinguished from specialists or workflow
   agents.

4. **Tweaking a team is a maze.** To customise a built-in team a user must
   apply the team (which silently overwrites their global enabled-agents
   list — `agentHandlers.ts:589–592`), switch tabs to the Agents tab, toggle
   agents, click "Save Team", then name the result. The card that triggered
   the flow has no Edit, Duplicate, or inline tweak affordance.

5. **The schema is fragile.** Custom teams reference agents by bare name,
   so renaming a custom agent silently breaks every team that referenced
   it. Built-in teams ship without an explicit lead. Workflow defaults are
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

| User-visible      | Replaces                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team              | "preset" / "agent mode preset"                                                                                                                           |
| Lead              | implicit `isOrchestrator` agent in a preset                                                                                                              |
| Specialist        | tool-use agent without delegation                                                                                                                        |
| Workflow          | workflow agent                                                                                                                                           |
| Setup             | the `setup` agent + setup wizard concepts                                                                                                                |
| Roster            | the launcher's contextual list of agents the active team groups                                                                                          |
| Effective roster  | the team's roster plus L1 additions minus L1 removals — what the lead actually sees on a given Run                                                       |
| L1 / L2 / L3      | the three customization levels (this-run roster tweak / save-as-new-team modal / full team editor in the Multi-Agent tab)                                |
| Run               | one click of the launcher's Run button (and any follow-up turns within the same session)                                                                 |
| Session           | the launcher's currently-open conversation; cleared when the user closes the launcher tab                                                                |
| Researcher Access | TeXRA's free sign-in path (Researcher Access Program) — an alternative to bringing your own API key. Surfaced via `texra.auth.signIn`. Existing concept. |

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
  placeholder copy from `2026-04-13-orchestrator-ui-redesign.md` — those still ship.
- Replacing the VS Code walkthrough framework. The walkthrough remains the
  canonical "manual" onboarding path; the launcher is the conversational
  one. Walkthrough _step copy_ is updated to match team-first vocabulary
  (see "First-open flow"), but the surface is unchanged.
- Designing a sharing or marketplace flow for custom teams.
- Per-team overrides of Team Coordination toggles (auto-approve, kill
  switch, max delegation depth) — global today and stay global.
- A separate field-picker UI for domains. Domains are first-class on a
  team but not a navigable axis.

---

## Launcher UX

### Anatomy

Two stacked controls sit above the textarea: the **team picker** (top) and
the **agent picker** (below). The textarea, action buttons, model picker,
and Run button stay where `2026-04-13-orchestrator-ui-redesign.md` puts them. A
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
        │  💻 Computer Scientist        │
        │                                │
        │ Setup & utility                │
        │  🛠 Onboarding                 │
        │                                │
        │ Custom                         │
        │  (none yet)                    │
        │  ➕ New team           │
        └────────────────────────────────┘
```

### Agent picker — team-first, then everything else

The agent dropdown groups the active team's agents at the top, then surfaces
every other agent in the registry below. Picking an agent **does not**
switch teams — it replaces the agent selection for this run. If the picked
agent is outside the active team's roster, the launcher shows a single
inline note ("Just this run — your team returns next time.") and resets
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
         │  ☐ Show experimental agents  │
         │    (off by default)          │
         └──────────────────────────────┘
```

`getVisibleAgents` (`agentRegistry.ts:677–687`) is replaced for the launcher
by a team-aware grouping selector that returns four ordered sections:
`team`, `otherOrchestrators`, `otherSpecialists`, `otherWorkflows`,
`setup`. Each entry carries its `agentRole` so the dropdown can render
icons and the "lead" tag without re-deriving it.

### Roster strip — L1 inline tweak

The roster strip below the model row lists the active team's agents in
the order _lead → specialists → workflows_. The strip is collapsed by
default with a small `▸ Roster (13 agents)` chevron to keep the
first-open launcher tidy; clicking expands it. Hovering an entry exposes
a small ✕ that drops it for this run only; a final `+ Add` chip opens a
quick picker over every other agent in the registry.

By default — when nothing has been added or removed — the strip's title
reads `▾ Your team` and no footer line is rendered. Once the user makes
the first tweak, the title reads `▾ Your team — modified for this run`,
the active team chip gains a `•` dot (`🎓 Mathematician •`), and a
single footer line appears with two actions:

```
  ▾ Your team — modified for this run
    🎯 orchestrator           ← lead
    💬 chat   🔬 research   ✓ review
    ⚙ lean   🧮 simplifier ✕
    📄 correct  ✨ polish   🔄 merge
    [+ Add agent]

  Tweaks apply to this run only. [Save as new team] [Reset]
```

The unmodified state has no footer at all, so a brand-new user never
sees the word "Modified" before doing anything.

The **effective roster** is the launcher's term for what the lead
actually has access to on a given Run: the team's stored roster, plus
any L1 additions, minus any L1 removals. It exists only at run time and
is recomputed on every render. The dispatch payload sent to the lead
carries the effective roster explicitly so removed agents cannot be
selected even if the lead's prompt mentions them.

Rules:

- Tweaks live in **session state only**. They do not persist across
  reload. The team's stored roster is unchanged. `ENABLED_AGENTS` is
  unchanged.
- The active team chip gets the `•` dot only when there's an actual
  delta vs. the team's stored roster.
- "This run" means a single Run-button click. Tweaks survive across the
  follow-up turns of the same session (so the user can continue
  conversation without losing their override) but are cleared by
  switching teams, picking an out-of-team agent solo, hitting Reset, or
  closing the launcher (which clears all session state).
- Switching teams or picking an out-of-team agent solo discards pending
  L1 tweaks (the modified state belongs to the team that was active when
  the tweak was made; carrying it forward would be confusing).

### L2 — Save as new team

Clicking `Save as new team` in the modified footer opens a modal that is
pre-filled from the current launcher state. The user confirms; a custom
team is created and selected. Every field has a sensible default so the
"happy path" is hit Enter once.

```
┌──────────────────────────────────────────────┐
│  Save as new team                            │
│  Based on your current roster.               │
├──────────────────────────────────────────────┤
│  Name        [Mathematician (custom)      ]  │
│  Description [Mathematician without          │
│               simplifier, plus latexFixer.]  │
│  Icon        (•🎓) ( ⚛ ) ( ⚙ ) ( 💻 ) ( ✨ )│
│              ( 🔬 ) ( ✏️ ) ( 📐 ) ( + custom)│
│              (selected: 🎓)                  │
│                                              │
│  Lead        [🎯 orchestrator             ▾] │
│              The lead used by default when   │
│              you select this team.           │
│                                              │
│  ☐ Set as default team for new sessions      │
│                                              │
│                       [Cancel]  [Save team]  │
└──────────────────────────────────────────────┘
```

Defaults that prevent dead ends:

- **Name** prefills `{base team name} (custom)`. Required, non-empty.
- **Description** prefills a one-sentence summary of the diff against
  the base team (e.g., _"Mathematician without `simplifier`, plus
  `latexFixer`."_). User-editable.
- **Icon** is pre-selected to match the base team's icon, with a clear
  visual highlight (filled border and a leading `•` in the mockup).
  The sub-line `(selected: 🎓)` makes the choice text-readable. Team
  icons and agent icons share the same emoji pool — the rendering
  context (large team card vs. small agent badge) keeps them
  visually distinct, so `✨` can be a team icon and the `polish`
  agent's icon at the same time without confusion.
- **Lead** is pre-selected to the team's current lead in the launcher.
  When the modified roster contains more than one lead-role agent, the
  dropdown is populated with all of them and the **first lead from the
  source team's `leadAgentIds`** is pre-selected so Save is never
  blocked on first open. Helper text reads _"The lead used by default
  when you select this team."_ to make persistence explicit.
- **Set as default team** is unchecked by default. Checking writes a
  user-scoped preference so this team becomes the post-Onboarding
  fallback for new sessions on this machine.

The same modal opens for `+ New team` from the team picker. Both
entries are the same flow with the same pre-fills; the difference is
only the source state. The Multi-Agent tab's `+ New team` and `+ Save
current setup as team` also reuse this modal.

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
│ │       [Set up later]               │ │
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

**`[Set up later]` behavior.** Dismisses the welcome banner only.
Leaves the Onboarding team active and the launcher in its first-run
state so the user can still hit Run to talk to the setup agent. The
banner is replaced by a small one-line muted reminder above the team
picker: _"You can re-open setup any time from the Team dropdown →
Onboarding."_ The reminder hides as soon as the user switches to any
non-Onboarding team. (`[Set up later]` does not dismiss the
"🚀 TeXRA: Get Started" status-bar pill — only acquiring a credential
does.)

When the setup conversation reaches phase 8 (see "First-open flow"):

- the agent recommends a research team to the user based on their stated
  intent and waits for confirmation,
- on confirmation the agent writes `selectedTeamId` through
  `update_config`; the launcher's team picker switches, the welcome
  banner disappears, and the agent says one closing sentence in chat
  ("Done — set you up on Mathematician.") so the team change is visible
  conversationally as well as in the UI,
- if the user declines without picking another team, the launcher stays
  on Onboarding with a single inline note above the team picker:
  _"You're still on Onboarding. Pick a team from the dropdown above
  whenever you're ready — Mathematician, Physicist, Lean Project,
  Computer Scientist, or Software Engineer."_,
- the previous Onboarding state is always preserved — re-selecting
  Onboarding from the team picker re-runs the setup conversation at any
  time, including after upgrades.

The full phase sequence (probe → install → credentials → workspace →
verify → pick team → launch) and the intent-mapping table that
phase 8 uses are specified in the "First-open flow" section.

The `texra.gettingStarted` walkthrough and the "🚀 TeXRA: Get Started"
status-bar pill (`extension.ts:108–112`) gain team-aware copy and one
new pill state ("🎓 Pick your team" when a credential exists but the
user is still on Onboarding); both are detailed in "First-open flow".
Clicking either entry point selects the Onboarding team and opens the
launcher.

### Out-of-team specialist or workflow run

Picking an agent that isn't in the active team's roster runs that agent
on its own this run, without changing your team. The launcher shows a
single inline note and the team chip stays stable.

```
  Team   [🎓 Mathematician          ▾]
  Agent  [🎨 presenter              ▾]
         Builds a LaTeX Beamer deck
         from your paper.
         ⓘ Just this run — your team
           returns next time.
```

The next time the user opens the launcher, the agent picker resets to
the team's default lead. The team chip never leaves Mathematician.

---

## First-open flow

The team-first reframing changes _what_ first-open accomplishes, not just
the UI it's accomplished in. Today's setup story (`setup.yaml`,
`texra.gettingStarted` walkthrough, `setupAssistantCommand.ts`) ends with
the setup agent delegating directly to `orchestrator` or a workflow
agent. Under this PRD, first-open ends with the user **landing in a
research team** with their first task either already running or queued
in the launcher. The setup agent's job widens slightly: it picks the
team for the user and sets it before handing off.

### The seven phases

The setup agent's existing phase letters (A–H in
`resources/tool_use_agents/setup.yaml:120–162`) are renamed and one new
phase is inserted between "verify" and "launch". The phases run in
order; the agent skips any phase the probe shows is already done.

| #     | Phase                 | Today                                           | After                                                                                                           |
| ----- | --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1     | **Probe**             | `probe_environment` once                        | unchanged                                                                                                       |
| 2     | **Core LaTeX**        | install missing TeX dependencies                | unchanged                                                                                                       |
| 3     | **Editor extension**  | install LaTeX Workshop                          | unchanged                                                                                                       |
| 4     | **Credentials**       | sign-in OR API key                              | unchanged                                                                                                       |
| 5     | **Optional extras**   | Zotero / Lean / SoX                             | unchanged                                                                                                       |
| 6     | **Project source**    | sample / Overleaf / arXiv                       | unchanged                                                                                                       |
| 7     | **Verify**            | `verify_setup`, plain-language summary          | unchanged                                                                                                       |
| **8** | **Pick a team**       | _(missing — today goes straight to delegation)_ | **NEW: pick a research team based on the user's intent, set it as the launcher's active team**                  |
| 9     | **Launch first task** | delegate to `orchestrator` or `correct`         | delegate via the picked team's lead, or hand off to the launcher with the team selected and the textarea seeded |

### Phase 8 — Pick a team

After verify, the setup agent asks one short question: _"You'll work with
TeXRA in a team. Based on what you told me, I'd start you on
**{recommendation}** — does that sound right, or would you rather pick
something else?"_ The recommendation is derived from what the user said
in their intro turn:

| User intent signal                                                     | Recommended team    |
| ---------------------------------------------------------------------- | ------------------- |
| mentions "Lean", "formalization", "blueprint"                          | `lean-project`      |
| mentions "physics", "numerics", "Wolfram", "experiment"                | `physicist`         |
| mentions "ML", "machine learning", "transformer", "neural", "training" | `cs-ml`             |
| mentions "software", "code", "implementation", "debugging", "tests"    | `software-engineer` |
| anything else, including silence                                       | `mathematician`     |

If the user accepts, the agent writes `texra.launcher.selectedTeamId`
through `update_config` (the allowlist gains this key) and confirms in
one sentence: _"Done — set you up on Mathematician. `orchestrator` is
your lead, with research, review, lean, and others on the roster."_ The
"Done —" prefix is mandatory; it pairs the conversational confirmation
with the visual UI change so the user always sees that something
happened.

If the user declines and asks to see options, the agent lists the available
built-in teams in one paragraph and waits for a choice. Three branches from
there, all explicit:

1. **User picks a team by name.** Agent writes the team via
   `update_config` and confirms with the same "Done —" sentence.
2. **User says "I don't know" or types something the agent can't map to
   a team.** Agent gives one-line summaries of each team
   (Mathematician for proofs and papers, Physicist for derivations and
   numerics, Lean Project for Lean 4, Computer Scientist for CS
   research, Software Engineer for codebases) and asks once more. If the user
   is still unsure, the
   agent says _"No worries — I'll leave you on Onboarding for now. You
   can pick a team any time from the Team dropdown in the launcher."_
   and stops without writing `selectedTeamId`. This branch never
   silently picks Mathematician for the user.
3. **User explicitly declines all teams.** Same closing sentence as
   branch 2; no team is written.

The agent never re-asks more than twice in phase 8. After the second
ask, it always concludes with the "Onboarding for now" sentence, so
the conversation cannot loop on team selection.

The agent **does not enumerate every specialist or workflow on the
team**. The launcher's roster strip will show that the moment the user
opens it. The setup conversation ends with at most one short paragraph
of team explanation.

### Phase 9 — Launch (or hand off)

Two paths replace today's "delegate-or-stop" branch:

1. **Delegate within the team.** If the user named a concrete first task
   ("review my paper", "fix grammar in main.tex"), the setup agent
   delegates to the team's lead with that instruction. The team's
   roster reaches the lead via the effective-roster dispatch payload
   already specified in the data model section, so the lead can
   dispatch only over the team's agents.
2. **Hand off to the launcher.** If the user is exploring or wants to
   pick their own task, the setup agent says one closing sentence
   (_"You're set. Hit Execute in the main view whenever you're ready."_)
   and stops. The launcher already has the team selected from phase 8;
   the welcome banner has already been dismissed; the textarea is empty
   with the launcher's normal placeholder.

The setup agent never "completes" by leaving the user on the Onboarding
team. Either it transitions them to a research team (phase 8) or, if
the user explicitly declines team selection, it stays on Onboarding
with a clear note: _"You can pick a team any time from the team
dropdown — Mathematician, Physicist, Lean Project, Computer Scientist
(ML), or Software Engineer."_

### `setup.yaml` changes

The system prompt in `resources/tool_use_agents/setup.yaml` is rewritten
so that:

- The "What TeXRA actually is" section leads with **teams** instead of
  agents. The orchestrator/specialist/workflow/setup role decomposition
  is mentioned once as the structure inside a team, not as a peer
  enumeration.
- Phase H is split into phase 8 (pick a team) and phase 9 (launch).
- Phase 8 includes the intent-mapping table above as a short paragraph.
- The opening question gains a third clause: _"If you already know
  whether you're working on math, physics, ML, or Lean, tell me — I'll
  set the team for you when we're done."_ — so the agent has a
  recommendation ready by phase 8 even when the probe is silent.
- The "Bash etiquette", "bash vs send_to_terminal", "Secrets" sections
  are unchanged.

### `update_config` allowlist gains team selection

Today's `update_config` allowlist (in
`src/tools/setup/UpdateConfigTool.ts` or equivalent) covers
bibliography path, Zotero port, SoX path, LaTeX formatter, TikZ input
directory, auto-compile toggle, git commit depth, max image dimension.

It gains:

- `texra.launcher.selectedTeamId` — write only when the value is in
  `{mathematician, physicist, lean-project, cs-ml, software-engineer,
onboarding, custom-*}` (regex). Writes target `user`, not `workspace`, so the
  team carries across projects.

The setup agent uses this once per session, in phase 8, after the user
confirms.

### Walkthrough changes

`package.json` `contributes.walkthroughs.texra.gettingStarted` is
rewritten so the manual checklist matches the team-first story. Steps
collapse from eleven to nine; the "Use the orchestrator" and "Pick your
field" steps merge.

| Today (step id, title)                           | After                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setupAssistant` "Run the setup assistant agent" | unchanged — title becomes "Set up TeXRA in one conversation"                                                                                                                                                                                                                                                                                                                                                                                         |
| `sampleWorkspace` "Try the sample project"       | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apiKeys` "Add your API key"                     | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `signIn` "Or just sign in"                       | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `stageFiles` "Pick your files"                   | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `agentModel` "Use the orchestrator"              | **merged into `pickTeam`** (below)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `multiAgent` "Pick your field"                   | renamed to **`pickTeam`** "Pick a team" — completes when `selectedTeamId !== 'onboarding'`. Description: _"You'll work in a team — Mathematician, Physicist, Lean Project, Computer Scientist, or Software Engineer. The team's lead orchestrator handles your message; the team's specialists and workflows are pre-populated for the work you do. Tweak any team in the Multi-Agent tab; tweak just-this-session in the launcher's roster strip."_ |
| `autoExtract` "Auto-extract figures (optional)"  | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `progress` "Hit Execute!"                        | unchanged — copy updated to refer to "the team's lead" instead of "the orchestrator"                                                                                                                                                                                                                                                                                                                                                                 |
| `review` "Check what it did"                     | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `housekeeping` "Clean up when you're done"       | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Total step count goes from 11 to 10. Step 6 (`agentModel`) is removed
because picking a team _is_ picking a default lead orchestrator; the
launcher's agent picker still exposes the choice on every session for
users who want to swap.

### Status-bar pill changes

The pill at `extension.ts:108–112` ("🚀 TeXRA: Get Started") shows when
no credential is present. Today it stays hidden once a credential
exists. After this PRD, it has one additional state:

| Condition                                             | Pill                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| No credential                                         | "🚀 TeXRA: Get Started" → calls `texra.runSetupAssistant`                                            |
| Credential present, `selectedTeamId === 'onboarding'` | "🎓 Pick your team" → calls `texra.showMainView` and opens the team picker dropdown (less prominent) |
| Credential present, `selectedTeamId !== 'onboarding'` | hidden                                                                                               |

Only the first pill state runs `texra.runSetupAssistant`. The middle
state is deliberately a different command (`texra.showMainView`) that
focuses the team picker; setup _is_ already done at this point in the
credential sense, so re-entering the setup agent would be redundant.
The middle state catches users who installed credentials manually
(through API key or sign-in) outside the setup agent — they have no
research team yet and would otherwise sit on Onboarding indefinitely.

### Re-running setup

Setup is a team like any other; users can re-enter it any time from the
team picker. Two additional entry points exist for upgrades and
re-installs:

1. The `texra.runSetupAssistant` command (existing) is unchanged.
   Selecting Onboarding from the team picker is equivalent.
2. After a TeXRA upgrade introduces new dependencies (e.g., a new
   default tool), the setup agent's `verify_setup` reports them as
   missing on next run. The launcher surfaces a small one-time banner:
   _"TeXRA was updated and may need a new tool. Want me to check?
   [Check environment] [Not now]"_. The `[Check environment]` button
   re-runs setup, which is conversational and asks before installing
   anything — so users can interpret it as low-risk. The banner is
   gated on a workspace-state version key so it appears at most once
   per upgrade.

### Behaviour when credentials are removed

If a user removes their last credential (signs out, deletes API key)
while running TeXRA, `extension.ts`'s credential watcher already shows
the "🚀 Get Started" pill again. After this PRD, the launcher also:

- preserves `selectedTeamId` (Mathematician / etc.) so when credentials
  return the user lands back on the same team,
- displays a single inline banner above the team picker: _"Your
  credentials were removed. The setup assistant can sort that out — or
  add a key in the Models tab."_, with `[Run setup]` and `[Open
Models]` actions,
- does **not** auto-switch to the Onboarding team. Switching teams on
  every credential blip would lose the user's place. The Onboarding
  team is one click away from the team picker for users who want it.

### Failure-mode behaviour during setup

The setup agent is conversational and may hit dead ends (no package
manager detected, network failure during install, user cancels a
dialog). Two rules ensure the launcher is never stranded:

1. **Setup agent failures do not change `selectedTeamId`.** The team is
   set only in phase 8 after the user confirms. If setup fails before
   phase 8 (e.g., during install), the launcher remains on Onboarding
   and the user can re-run setup or proceed manually via the
   walkthrough.
2. **Phase 8 never silently writes the team.** If the user does not
   confirm the recommendation, the setup agent does not call
   `update_config` for `selectedTeamId`. The launcher stays on
   Onboarding until a credential exists and the user picks a team
   themselves (from the team picker, the Multi-Agent tab, or by
   re-running setup).

---

## Settings — Multi-Agent tab

The Multi-Agent tab is the home of the team registry. It groups teams by
source (Built-in, Setup & utility, Custom) and surfaces explicit
Use / Edit / Duplicate / Delete actions so the Agents-tab-and-back-again
dance disappears.

The current implementation in `MultiAgentTab.ts` (preset grid +
Team Coordination toggles) is **replaced wholesale** by the layout below;
file-line citations to the current code in this section name what is
removed, not what stays.

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
│ │ Specialists: prover,     │ │ Specialists: research,   │            │
│ │  lean, research,         │ │  numerics, review,       │            │
│ │  numerics, review,       │ │  search, presenter,      │            │
│ │  simplifier, latexFixer, │ │  simplifier, latexFixer, │            │
│ │  progressCheck           │ │  progressCheck           │            │
│ │ Workflows: correct,      │ │                          │            │
│ │  polish, generic,        │ │ Workflows: criticize,    │            │
│ │  devise, apply           │ │  generic, devise, apply  │            │
│ │                          │ │                          │            │
│ │  [Use]  [Duplicate]      │ │  [Use]  [Duplicate]      │            │
│ └──────────────────────────┘ └──────────────────────────┘            │
│ ┌──────────────────────────┐ ┌──────────────────────────┐            │
│ │ ⚙ Lean Project           │ │ 💻 Computer Scientist    │            │
│ │ Lean 4 formalization     │ │ CS research workflow.    │            │
│ │ workflow.                │ │                          │            │
│ │ Lead: 🎯 leanOrchestrator│ │ Lead: 🎯 orchestrator    │            │
│ │ Specialists: lean,       │ │ Specialists: research,   │            │
│ │  leanSearch, leanSimpl-  │ │  numerics, coder,        │            │
│ │  ifier, leanBlueprint,   │ │  testEngineer, search,   │            │
│ │  latexFixer, progress-   │ │  review, presenter,      │            │
│ │  Check                   │ │  simplifier, latexFixer, │            │
│ │ Workflows: (none)        │ │  progressCheck           │            │
│ │  [Use]  [Duplicate]      │ │ Workflows: criticize,    │            │
│ │                          │ │  generic, devise, apply, │            │
│ │                          │ │  polish                  │            │
│ │                          │ │  [Use]  [Duplicate]      │            │
│ └──────────────────────────┘ └──────────────────────────┘            │
│                                                                      │
│ ┌──────────────────────────┐                                         │
│ │ 🧰 Software Engineer      │                                         │
│ │ Code implementation and  │                                         │
│ │ review workflow.         │                                         │
│ │ Lead: 🧰 engineer        │                                         │
│ │ Specialists: coder,      │                                         │
│ │  codeReviewer,           │                                         │
│ │  testEngineer,           │                                         │
│ │  codeSimplifier,         │                                         │
│ │  progressCheck           │                                         │
│ │ Workflows: (none)        │                                         │
│ │  [Use]  [Duplicate]      │                                         │
│ └──────────────────────────┘                                         │
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
│ Custom              [+ New team]   [+ Save current setup as team]   │
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

Card differences vs. the current `MultiAgentTab.ts`:

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

Each action button has a stable tooltip so a first-time user reading
just the cards can tell the actions apart without trial-and-error:

| Button    | Tooltip                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| Use       | "Switch to this team in the launcher."                                             |
| Edit      | "Edit this team's lead, specialists, and workflows. (Custom teams only.)"          |
| Duplicate | "Make a custom copy of this team you can edit. The original built-in stays as-is." |
| Delete    | "Delete this custom team. Built-in teams cannot be deleted."                       |

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

### "+ Save current setup as team"

A button at the top of the Custom group is the explicit handoff from the
launcher. Clicking it opens the same team editor with the launcher's
current effective roster prefilled — same as L2's `Save as new team`,
just initiated from settings instead of from the launcher footer.

### Team Coordination section

Mechanically unchanged from today (auto-approve subagent steps, detach
subagents, worktree support, kill-switch, max delegation depth). The
section moves below the team grid and stays a sibling — these are
global delegation behaviours, not per-team. A future PRD can move them
per-team if needed.

Each toggle gains a one-line description below its label so first-time
users don't have to know what "subagent" or "worktree" means before
deciding:

| Toggle                         | Description (one line shown under the toggle)                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| Auto-approve subagent steps    | "Run delegated tasks without asking. You can still pause from the Progress view."                   |
| Detach subagents on completion | "Free a slot when an agent finishes so the lead can dispatch the next task immediately."            |
| Worktree support               | "Run multiple agents in parallel on copies of your repo so they don't trip over each other."        |
| Allow orchestrator kill-switch | "Show a Stop button while the lead is running. Useful when a multi-step plan is going off-track."   |
| Max delegation depth           | "How many levels deep the lead can delegate (lead → specialist → sub-specialist). Higher = deeper." |

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
│ ☑ progressCheck │                · 💻 Computer Scientist        │
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

1. **`Save Team` toolbar button removed.** Today's flow (toggle agents
   here, click `Save Team`, name in a `vscode.window.showInputBox`) lives
   in `AgentsTab.ts:225–227` and `agentHandlers.ts:609–652`. It is replaced
   by the launcher's `Save as new team` (L2) and the Multi-Agent tab's
   `+ Save current setup as team` / `+ New team`. The Agents tab is no
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
   role badge `Setup`, and a disabled toggle. Hovering the 🔒 icon
   shows the tooltip _"Setup agents are part of the Onboarding team and
   stay enabled."_ The detail pane shows the same sentence as a static
   note plus the "Open YAML" affordance so power users can read the
   agent's prompt.
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

## Settings — Cross-tab consistency

The team-first launcher only works if the Settings view itself reads as one
coherent surface. Today the eight tabs (Memory, History, Models, Agents,
Multi-Agent, LaTeX, Tools, Git) diverge in vocabulary, save model, action
placement, section headers, empty states, confirmation behavior, and reset
affordance. This PRD defines the rules every tab must follow.

### Vocabulary

| Canonical term                         | Replaces                                                                                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team                                   | "agent mode preset", "preset" (display surface only — schema name `AgentModePresetSchema` is renamed to `TeamSchema`; storage key `WorkspaceStateKey.CUSTOM_AGENT_PRESETS` keeps its name to avoid migration churn but is referred to as "custom teams" in copy) |
| Lead                                   | the orchestrator entry of a team                                                                                                                                                                                                                                 |
| Specialist                             | a tool-use agent without delegation                                                                                                                                                                                                                              |
| Workflow                               | a workflow agent                                                                                                                                                                                                                                                 |
| Setup                                  | the privileged onboarding agent role                                                                                                                                                                                                                             |
| Auto-approve subagent steps            | "Super YOLO", "auto-approve delegated tasks" (rename internal signal `superYoloEnabled` → `autoApproveSubagentSteps` in `SettingsApp.ts`)                                                                                                                        |
| Agents tab "Tool Use" sub-tab          | renamed to **"Tool-Use Agents"** to disambiguate from the Tools tab (`AgentsTab.ts:259`)                                                                                                                                                                         |
| Tools tab "Memory & Workflow" category | renamed to **"Workflow tools"** to disambiguate from the Memory tab (`ToolsTab.ts:66`)                                                                                                                                                                           |

`AgentsTab.ts:269` ("Save current agent configuration as a team") and
similar tooltips are updated to use "team" everywhere the user sees them.
The schema rename happens in one commit; tooltips and labels in another.

### Save model

One rule: **every toggle saves immediately on change; every named entity
(team, custom agent, GitHub token) is saved through an explicit modal**.

Today's outlier is the Agents tab `Save Team` button
(`AgentsTab.ts:225–227, 268–272`), which conflates "edit a list" with
"persist a named entity". This PRD already removes that button from the
Agents tab. The replacement flows are explicit (launcher footer's `Save as
new team`, Multi-Agent tab's `+ New team` and `+ Save current setup as
team`), each opening a modal that takes a name, description, and icon.

No tab has a footer Save button. No tab buffers changes. Every other tab
(Memory toggle, Models keys, Tools approvals, Git author, LaTeX apply
buttons, Multi-Agent coordination toggles) is already immediate-on-change
and stays that way.

### Action placement

Every tab follows the same rule: **primary action in the tab header, on
the right; row-level actions on each row, on the right**.

| Today                                                                       | After                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| AgentsTab header right: `Save Team` (removed), `From Template`, `New Agent` | header right: `+ New agent`, `+ From template`                                            |
| MultiAgentTab: card-level delete on hover only (`MultiAgentTab.ts:288`)     | card-level `Use` / `Edit` / `Duplicate` / `Delete` always visible (delete still confirms) |
| LaTeXTab: per-card `Apply` (right) and `Reset` (right)                      | unchanged — already follows the rule                                                      |
| ToolsTab: `Re-check` button at top right                                    | unchanged                                                                                 |
| ModelsTab: per-row toggles                                                  | unchanged                                                                                 |
| Memory / History tabs: scattered                                            | header right gets a single primary action (`+ New memory`, `Clear all`)                   |

Buttons in row-actions read primary → destructive left-to-right with
spacing token `var(--spacing-medium)` between them. Destructive actions
use the same VS Code `error` foreground regardless of tab.

### Section headers

One pattern, used everywhere a tab has more than one logical group of
controls: small uppercase, 0.5px letter-spacing, `border-bottom` on the
secondary border color, font-size token. This is the existing
`LaTeXTab.ts:339` / `ToolsTab.ts:183` pattern; it becomes the project
default and replaces the `<h3>` style in `MultiAgentTab.ts:458, 470` and
the bespoke `.section-title` in `GitTab.ts:76`.

The shared style ships as `.section-header` in
`packages/extension/src/settingsView/frontend/styles.ts` (the file already exists, currently
66 lines for `.settings-header` only). Tab-local definitions of
`.section-header`, `.category-header`, and `.section-title` are deleted.

### Empty states

Every tab that can be empty (Memory, History, Multi-Agent custom group,
Agents custom group) renders the same shape: centered icon, one short
sentence, one inline action.

```
        ┌─────────────────────────────────┐
        │                                 │
        │              📭                 │
        │                                 │
        │   No custom teams yet.          │
        │   [+ Build your first team]     │
        │                                 │
        └─────────────────────────────────┘
```

The shared component is `<settings-empty-state icon=… text=… action=…>`
in `packages/extension/src/settingsView/frontend/components/`. LaTeX and Tools loading
spinners are kept distinct (loading is not empty); they get a shared
`<settings-loading-state label=…>` partner. Tabs that cannot be empty
(Models, Agents built-in group, Multi-Agent built-in group) do not adopt
either.

### Confirmation dialogs for destructive actions

Today, deletes happen instantly. This is the highest footgun-per-pixel in
the whole settings view. The rule: **every destructive action behind an
explicit "Delete" / "Remove" / "Reset" / "Clear" verb confirms**.

| Action                 | Today                                | After                                                                                             |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Delete custom team     | instant (`MultiAgentTab.ts:332–337`) | `vscode.window.showWarningMessage('Delete team {name}?', { modal: true }, 'Delete')`              |
| Delete custom agent    | instant                              | same modal pattern                                                                                |
| Delete memory item     | instant                              | same modal pattern                                                                                |
| Reset LaTeX setting    | instant (`LaTeXTab.ts:689`)          | inline confirm: button label flips to "Confirm reset" for 3s on first click; second click commits |
| Remove GitHub token    | instant                              | modal `'Remove GitHub token? You will need to add it again to use Git features.'`                 |
| Clear all history      | already confirmed                    | unchanged                                                                                         |
| Reset agents directory | already confirmed                    | unchanged                                                                                         |

The inline-confirm pattern (button flips for 3s) is used for low-stakes
resets (LaTeX setting, code style); the modal is used for state the user
cannot easily reconstruct (custom team membership, custom agent YAML,
saved memory, GitHub token).

### Reset to default affordance

Every setting that has a default gets a small revert icon
(`codicon-discard`) shown next to the current value when it differs from
the default. Hovering reveals a tooltip with the default. Clicking
applies the inline-confirm pattern (flips to `Confirm reset` for 3s).

Tabs that gain this affordance: Multi-Agent (per coordination toggle),
Models (per model on/off), Tools (per approval toggle), Git (mark commits
toggle). Tabs that already have it (LaTeX, Agents directory) keep their
flow but use the same icon and confirm pattern.

### Direct deep-linking to tabs

Today, the `SET_TAB` message (`SettingsApp.ts:246`) supports an explicit
`tabIndex` and an Agents-only `agentSubTab`. After this PRD, every tab
declares a stable string id (`memory`, `history`, `models`, `agents`,
`multi-agent`, `latex`, `tools`, `git`) and `SET_TAB` accepts the id
plus an optional sub-section anchor (`agents:tool-use`,
`multi-agent:custom-teams`, `models:helper`). Existing numeric `tabIndex`
is supported during one minor-version migration window.

Concrete deep links the launcher needs:

- `multi-agent` (when the user clicks `+ New team` from the team
  picker)
- `multi-agent:custom-teams` (when L2 `Save as new team` completes — the
  view scrolls to the new team's card)
- `agents:tool-use` (when the user clicks `Manage agents →` in the team
  editor)
- `models` (when the setup agent finishes credential setup and offers to
  pick a default model)

---

## Settings — Other tabs

The team-first launcher should not creep into tabs whose responsibilities
are orthogonal. Explicit scope rules close the audit's "PRD impact" open
questions:

### Models tab — global, not per-team

Models are a **global** setting, not a per-team one. The Models tab keeps
its current scope: API keys, per-model on/off toggles, helper-model
choice. Teams do not pin a model. The launcher's model dropdown reads
from the same global enabled-models list regardless of team.

Rationale: models cross-cut domains (a Mathematician team may want Claude
or Gemini depending on the task), and per-team model lists explode the
configuration surface. Power users who want a model preference per team
can store it as a domain tag in the team and a future PRD can revisit.

### Memory tab — session, not per-team

Memory is **session-scoped** today (Markdown notes the user can attach to
any run). Teams do not partition memory; switching teams mid-session
preserves memory. The Memory tab is unchanged.

Rationale: memory is the user's project context, not the team's. A
Mathematician working on the same paper as a Physicist team-mate should
share notes.

### Tools tab — global tool registry, not per-team

The Tools tab continues to reflect global tool availability and global
approval toggles. Teams do not whitelist tools; the per-agent tool list
inside each YAML is the authoritative scope.

Rationale: tools are a security surface (`bash`, `send_to_terminal`,
GitHub token use). A per-team whitelist would split that surface across
many teams and weaken auditability. The Tools tab stays the single place
where the user reasons about what TeXRA can run on their machine.

### History tab — gains a team filter

History adds one filter chip alongside the existing search box: `Team`,
which lists every team the user has run in. Default is "All teams".
Selecting a team filters the list. This is the only History change.

Rationale: once teams are first-class, a user who has run Mathematician
sessions and Physicist sessions in the same workspace will want to see
each separately without text-searching.

### Git tab — unchanged

Git settings (commit author, GitHub token, PR subscriptions) are
team-independent. The Git tab is unchanged.

### LaTeX tab — unchanged

LaTeX dependencies and recommended VS Code settings apply uniformly. The
LaTeX tab is unchanged. The setup agent's environment-probing is the
only thing that writes here, and it does so through the same
`update_config` allowlist.

### Codex settings live with Codex (Models, not Tools)

Today Codex has model-like settings (sandbox mode, reasoning effort) in
the Tools tab (`ToolsTab.ts:332–349`). They move to the Models tab under
a Codex sub-section when Codex is the helper model. The Tools tab keeps
only the bash approval toggle and the tool-availability list.

Rationale: users expect "what model" and "how does that model behave" to
sit together. Codex's executable surface (the `codex` binary) remains in
Tools as a tool entry; its model behaviour (sandbox/effort) lives where
the user picks models.

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

The canonical shipped roster lives in `AGENT_MODE_PRESETS`
(`src/shared/schemas/agentPresets.ts`); the CLI wraps those records as
`source: 'built-in'` at runtime. The table below is a current snapshot of
that source plus the root selected from `BUILTIN_TEAM_ROOT_AGENT_NAMES`.
Setup/onboarding seeding is handled separately and is not a built-in team
card.

| id                  | name               | icon                       | lead               | specialists                                                                                                                   | workflows                                           |
| ------------------- | ------------------ | -------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `lean-project`      | Lean Project       | `codicon-symbol-structure` | `leanOrchestrator` | `lean`, `leanSearch`, `leanSimplifier`, `leanBlueprint`, `latexFixer`, `progressCheck`                                        | (none)                                              |
| `physicist`         | Physicist          | `codicon-symbol-operator`  | `orchestrator`     | `research`, `numerics`, `review`, `search`, `presenter`, `simplifier`, `latexFixer`, `progressCheck`                          | `criticize`, `generic`, `devise`, `apply`           |
| `mathematician`     | Mathematician      | `codicon-symbol-number`    | `orchestrator`     | `prover`, `lean`, `research`, `numerics`, `review`, `simplifier`, `latexFixer`, `progressCheck`                               | `correct`, `polish`, `generic`, `devise`, `apply`   |
| `cs-ml`             | Computer Scientist | `codicon-symbol-method`    | `orchestrator`     | `research`, `numerics`, `coder`, `testEngineer`, `search`, `review`, `presenter`, `simplifier`, `latexFixer`, `progressCheck` | `criticize`, `generic`, `devise`, `apply`, `polish` |
| `software-engineer` | Software Engineer  | `codicon-tools`            | `engineer`         | `coder`, `codeReviewer`, `testEngineer`, `codeSimplifier`, `progressCheck`                                                    | (none)                                              |

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
7. **Apply team rule.** `Use` from the Multi-Agent tab and `+ New team`
   after Save in the launcher both call the same internal selector;
   neither mutates `WorkspaceStateKey.ENABLED_AGENTS` or
   `ENABLED_TOOL_USE_AGENTS`. The wholesale-overwrite path in
   `handleApplyAgentModePreset` (`agentHandlers.ts:589–592`) is removed.
8. **Default lead rule.** Saving or editing a team requires
   `defaultLeadAgentId` to be set and ∈ `leadAgentIds`. Save is disabled
   in the editor when this is not satisfied.
9. **Setup-driven team selection.** The setup agent owns team selection
   for first-run users via phase 8 of the first-open flow: it recommends
   a research team based on the user's stated intent and writes
   `selectedTeamId` through `update_config` only after the user
   confirms. The launcher does not auto-promote based on probe signals
   alone — silent team changes are confusing. The launcher stays on
   Onboarding in three cases: (a) setup fails before reaching phase 8,
   (b) setup reaches phase 8 but the user declines the recommendation
   without picking another, (c) setup runs to completion but the user
   never confirmed in phase 8. Case (b) additionally surfaces an
   inline note above the team picker (per First-open flow); cases (a)
   and (c) do not. The launcher subscribes to the `selectedTeamId`
   workspace-state key so the team picker, agent picker, and welcome
   banner update without a reload when the setup agent writes.
10. **Built-in team immutability.** `Edit` is hidden on built-in cards.
    Any handler that receives a write request for a `builtIn: true` team
    rejects it.
11. **Disabling an agent in a team.** Disabling an agent that is in any
    team requires confirmation (described in the Agents tab section).
    Disabled agents are kept in team storage and appear unchecked-and-grey
    in the team editor — re-enabling restores the team to working order
    without re-saving.
12. **Invalid `defaultLeadAgentId` at load time.** If a team's stored
    `defaultLeadAgentId` no longer resolves (agent removed, custom agent
    deleted, source key changed) the launcher uses the first resolvable
    entry of `leadAgentIds` as the effective default and surfaces a
    one-time toast naming the team. If no entry of `leadAgentIds`
    resolves, the team is marked as `broken` in the Multi-Agent grid (no
    `Use` button, an inline "Open editor to repair" link); the launcher
    silently falls back to `mathematician` if the broken team was active.
13. **Saving a team with disabled agents.** The team editor allows saving
    a team that contains agents currently disabled in the Agents tab. A
    yellow note in the editor explains this: _"This team includes agents
    you've disabled. They will be hidden from the launcher until you
    re-enable them."_ Saving is allowed because the disabled state is a
    user preference, not a deletion; teams should survive enable/disable
    toggles without losing membership.
14. **Workflow agent picked from the agent dropdown.** Selecting a
    `workflow`-role agent from the launcher's agent picker — whether
    in-team or out-of-team — switches the launcher to its
    workflow-session UI inline: file selectors slide in below, the
    textarea label changes to optional notes, the run button label
    changes to `▶ Run`. The team chip and roster strip remain. This is
    the only place where selecting an agent changes the launcher's
    surrounding chrome; the change is driven by `agentRole === 'workflow'`,
    not by a separate session-type toggle.
15. **Setup writes during user input.** When the setup agent writes
    `selectedTeamId` while the user has the launcher open, the launcher
    re-renders the team picker, agent picker, and welcome banner but
    **never clears the textarea** and never moves the cursor. If the
    user happens to be typing into the launcher mid-setup (rare but
    possible — e.g., they opened a second instance of the launcher),
    their text is preserved. Auto-promoted team change does swap the
    agent picker's default to the new team's lead, but if the user has
    already selected an agent for this session (`selectedAgentId !==
previous defaultLeadAgentId`) their choice is preserved.
16. **Broken team recovery.** A team becomes _broken_ when none of its
    `leadAgentIds` resolve at load time (per rule 12). In the
    Multi-Agent tab, broken team cards show a red border, an inline
    error _"Lead agent missing"_ in place of the lead row, and replace
    the `Use` button with a single `Open editor to repair` link. The
    team editor opens with the lead section highlighted and a banner
    _"This team's lead agent (`{ref}`) is no longer available. Pick a
    new lead and save."_ Save remains disabled until at least one valid
    lead is checked. Until repaired, the launcher hides broken teams
    from its team picker dropdown to prevent re-selection. If the
    broken team was the active team, the launcher silently falls back
    to `mathematician` and surfaces the same one-time toast as rule 12.
17. **Disable confirmation copy.** When disabling an agent that is
    referenced by one or more teams, the confirmation modal lists the
    affected teams and reads: _"`{agent}` is used by {team list}. If
    you disable it, those teams will run without it — the lead can
    still coordinate the rest of the roster, but anything that needed
    `{agent}` won't happen."_ This is more concrete than today's "will
    run without it" so the user understands the practical consequence.
18. **Migration toast detail.** The post-upgrade migration toast (per
    Migration section) names every team it had to repair, one per
    line: _"Updated 'My Research Team' (custom): setup agent removed
    per schema migration."_ One toast per affected team, rather than a
    consolidated "Updated N teams" without specifics.

---

## Migration

The launcher reads four shapes today. The migration is fail-soft for each
and emits one consolidated toast on first launch after upgrade if anything
needed repair: _"Updated N teams to the new schema. See Settings → Multi-
Agent."_.

### Built-in presets in code

`AGENT_MODE_PRESETS` (`src/shared/schemas/agentPresets.ts`) is rewritten to
the new `Team[]` schema with explicit lead/default/spec/wf splits — see the
table above. No persistent state involved; this is shipped code.

### Custom teams in workspace state

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

### New default-team preference

The L2 modal's `Set as default team for new sessions` checkbox writes a
new user-scoped key, `texra.launcher.defaultTeamId`. Migration on first
boot after upgrade:

| Today's persisted state                                   | Maps to                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key absent                                                | Read default of `mathematician` for users with credentials, `onboarding` for users without; do not write the key. The launcher's "Restore on reopen" rule (Behaviour rule 3) handles fallback so an absent key never breaks the launcher. |
| Key present, value resolves to a known team id            | Use as the post-Onboarding default team for new sessions on this machine.                                                                                                                                                                 |
| Key present, value does not resolve (custom team deleted) | Fall back to `mathematician` and clear the key with a one-time toast: _"Your default team is no longer available. Picked Mathematician for new sessions — change it any time from the team picker."_                                      |

This key is read only when no `selectedTeamId` is persisted for the
current workspace; it does not override an active workspace selection.

---

## Implementation surface

| Concern                                                    | File                                                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentRole` field on agent YAMLs                           | `resources/agents/*.yaml`, `resources/tool_use_agents/*.yaml`, `prompts/agents/remote/**/*.yaml`                                                                 |
| `agentRole` derivation + `AgentEntry.ref()`                | `src/agent/index/agentRegistry.ts`                                                                                                                               |
| Team schema, built-in records, migration                   | `src/shared/schemas/agentPresets.ts`                                                                                                                             |
| Custom team CRUD handlers                                  | `packages/extension/src/settingsView/handlers/agentHandlers.ts`                                                                                                  |
| Multi-Agent tab grid + team editor                         | `packages/extension/src/settingsView/frontend/tabs/MultiAgentTab.ts`                                                                                             |
| Agents tab role badges, "Used by teams", setup-locked rows | `packages/extension/src/settingsView/frontend/tabs/AgentsTab.ts`, `AgentSelectionPanel.ts`                                                                       |
| Cross-tab vocabulary, save model, action placement         | every `packages/extension/src/settingsView/frontend/tabs/*.ts` (one-line text changes per tab)                                                                   |
| `<settings-empty-state>`, `<settings-loading-state>`       | `packages/extension/src/settingsView/frontend/components/` (new)                                                                                                 |
| Confirmation modals for destructive actions                | `MultiAgentTab.ts`, `AgentsTab.ts`, `MemoryTab.ts`, `GitTab.ts`, `LaTeXTab.ts`                                                                                   |
| Reset-to-default revert icon                               | `packages/extension/src/settingsView/frontend/components/RevertButton.ts` (new), adopted across tabs                                                             |
| `SET_TAB` deep-link by id + sub-section                    | `packages/extension/src/settingsView/frontend/SettingsApp.ts`, `src/shared/schemas/settingsViewMessages.ts`                                                      |
| Codex settings move from Tools to Models                   | `packages/extension/src/settingsView/frontend/tabs/ToolsTab.ts`, `ModelsTab.ts`                                                                                  |
| History team filter                                        | `packages/extension/src/settingsView/frontend/tabs/HistoryTab.ts`, `HistoryList.ts`                                                                              |
| Shared section header, card, badge, mono-path styles       | `packages/extension/src/settingsView/frontend/styles.ts`, `cardStyles.ts` (new), `monoStyles.ts` (new), `iconButtonStyles.ts` (new), `badgeStyles.ts` (extended) |
| Imperative→declarative refactors                           | `LaTeXTab.ts:472–481`, `HistoryList.ts:135, 191`, `AgentSelectionPanel.ts:468–472`, `SearchBar.ts:24–42`, `TaskGroupList.ts:623`                                 |
| Batched workspace updates                                  | `src/common/state/WorkspaceStateManager.ts` (`updateMany([[k, v], ...])`)                                                                                        |
| Launcher team picker + agent grouped picker                | `packages/extension/src/webview/frontend/components/InstructionPanel.ts`                                                                                         |
| Grouped option rendering (team-aware)                      | `src/shared/utils/selectTemplates.ts`                                                                                                                            |
| Launcher persisted state + session override                | `src/shared/schemas/mainView.ts`, `packages/extension/src/webview/frontend/MainApp.ts`                                                                           |
| First-run team selection + welcome banner                  | `packages/extension/src/webview/frontend/MainApp.ts`, `packages/extension/src/commands/setup/setupAssistantCommand.ts`                                           |
| Setup agent system prompt — phases 8 and 9, intent table   | `resources/tool_use_agents/setup.yaml`                                                                                                                           |
| `update_config` allowlist gains `selectedTeamId`           | `src/tools/setup/UpdateConfigTool.ts` (or current update_config implementation)                                                                                  |
| Walkthrough rewrite — collapse step 6 into 7, retitle      | `package.json` `contributes.walkthroughs.texra.gettingStarted`, `resources/walkthroughs/getting-started.md`                                                      |
| Status-bar pill third state ("Pick your team")             | `packages/extension/src/extension.ts:108–112`                                                                                                                    |
| Re-run-setup banner after upgrade                          | `packages/extension/src/webview/frontend/MainApp.ts` (gated on workspace-state version key)                                                                      |
| Credentials-removed inline banner                          | `packages/extension/src/webview/frontend/MainApp.ts`                                                                                                             |
| Effective-roster dispatch payload to lead                  | `src/agent/runtime/` (lead receives `effectiveRoster: AgentRef[]` in its delegate context)                                                                       |

### Implementation order

1. **Add `agentRole` derivation** on `AgentEntry` without changing UI. Audit
   the registry against the four expected role buckets. Add the field to
   built-in YAMLs as a follow-up cleanup.
2. **CSS consolidation pass.** Extract `cardStyles.ts`, `monoStyles.ts`,
   `iconButtonStyles.ts`, `emptyStateStyles.ts`; promote `.section-header`
   to `styles.ts`; extend `badgeStyles.ts`. Update LaTeX, Multi-Agent,
   Tools, Agents, Git tabs to import from shared modules. No visual
   change shipped — purely a refactor with snapshot tests.
3. **Imperative→declarative refactors.** Migrate the six violations
   listed in the principles section, one PR each. Each is independent
   and ships incrementally.
4. **Add `<settings-empty-state>` and `<settings-loading-state>`.** Adopt
   in Memory, History, Multi-Agent custom group, Agents custom group.
5. **Add confirmation modals** for delete-team, delete-agent,
   delete-memory, remove-token, reset-LaTeX. Inline-confirm pattern for
   reset; modal pattern for state the user can't reconstruct.
6. **Add `Team` schema + migration** for built-in and custom presets, with
   the new launcher fields stubbed but not yet rendered.
7. **Vocabulary rename.** `superYoloEnabled` → `autoApproveSubagentSteps`,
   "preset" copy → "team" across all tabs, "Tool Use" sub-tab →
   "Tool-Use Agents", "Memory & Workflow" tools category → "Workflow
   tools". Single commit, mechanical search-and-replace.
8. **Refactor `handleApplyAgentModePreset`** to _select_ a team rather
   than overwrite `ENABLED_AGENTS`. Behind a feature flag for one minor
   version — when disabled, fall back to today's wholesale overwrite.
9. **Render the new launcher controls** (team picker, grouped agent
   picker, roster strip, modified footer) behind the same feature flag.
10. **Render the new Multi-Agent tab** (Use/Edit/Duplicate/Delete
    actions, team editor side panel) behind the same flag.
11. **Refresh the Agents tab** (role badges, "Used by teams",
    visible-but-locked setup agents, removed `Save Team` button).
12. **`SET_TAB` deep-link upgrade** — accept tab id + sub-section anchor
    alongside numeric `tabIndex` for one minor-version migration window.
13. **Codex settings move** from Tools tab to Models tab (under helper
    model section).
14. **History team filter** added as a single chip alongside the existing
    search box.
15. **First-run rule** (Onboarding team auto-selected, welcome banner)
    once the launcher renders teams.
16. **Setup agent phases 8–9.** Update `setup.yaml` system prompt to add
    phase 8 (pick a team) and split phase 9 (launch or hand off). Add
    `texra.launcher.selectedTeamId` to the `update_config` allowlist.
    Add intent-mapping table to the prompt.
17. **Walkthrough rewrite.** Collapse `agentModel` step into `pickTeam`;
    rename and rewrite descriptions to use "team" vocabulary. Update
    `resources/walkthroughs/getting-started.md`.
18. **Status-bar pill third state** ("🎓 Pick your team" when credential
    present + `selectedTeamId === 'onboarding'`). Add the
    re-run-setup-after-upgrade banner gated on a workspace-state version
    key. Add the credentials-removed inline banner.
19. **Flip the flag** in a single release once the migration paths are
    verified against held-out fixtures of all four persisted shapes.

Steps 2–5 are pure consolidation and ship before any team-first UI. Steps
6–9 land the data model and feature-flagged UI. Steps 10–14 fill in the
new settings surfaces. Step 15 turns the system on for first-run users in
the launcher. Steps 16–18 update the conversational and walkthrough
on-ramps so they match. Step 19 removes the flag.

A small migration-fixture suite (`src/shared/schemas/__fixtures__/`) holds
serialized snapshots of each persisted shape: built-in-only, custom with
orchestrator, custom without orchestrator, persisted launcher with each
sessionType variant, no-credential first launch. Migration tests assert
each fixture produces a valid `Team[]` and `MainViewPersistedState`.

---

## Implementation principles — Lit and CSS

The settings view is a Lit application, but several tabs have grown
imperative and CSS-duplicated. This PRD treats consolidation as a
prerequisite for the cross-tab consistency rules above; they cannot be
enforced if every tab keeps its own copy of the same selectors.

### Declarative reactivity over imperative DOM

Rule: **`render()` is a pure function of `@property` and `@state`.**
Anything `render()` reads must be a reactive field; anything `render()`
needs to react to must trigger a state setter, not a manual
`requestUpdate()`.

The audit identified concrete violations to fix:

| File                     | Line    | Violation                                                                                                                | Fix                                                                                                                                                                                                                                |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LaTeXTab.ts`            | 472–481 | `button.classList.add('copy-success'); setTimeout(() => button.classList.remove(...), 2000)` for transient copy feedback | `@state() private copiedCommandId: string \| null = null;` + conditional class binding `class=${classMap({ 'copy-success': this.copiedCommandId === id })}`. Setter clears via a timer field cleaned up in `disconnectedCallback`. |
| `LaTeXTab.ts`            | 476–480 | `button.setAttribute('title', 'Copied!')`                                                                                | bound title in template: `title=${this.copiedCommandId === id ? 'Copied!' : 'Copy command'}`                                                                                                                                       |
| `HistoryList.ts`         | 135     | `this.state.setSearchIndex(...); this.requestUpdate();`                                                                  | move `searchIndex` to `@state()` on the component (or migrate the underlying state container to `@lit-labs/signals`); the manual `requestUpdate()` is the smell.                                                                   |
| `HistoryList.ts`         | 191     | second `this.requestUpdate()` after a non-reactive mutation                                                              | same fix                                                                                                                                                                                                                           |
| `AgentSelectionPanel.ts` | 468–472 | `requestAnimationFrame(() => shadowRoot.querySelector('.agent-list-item.selected')?.focus())`                            | use a Lit `ref()` on the selected item, focus inside `updated(changedProperties)` when `selectedAgentId` changed                                                                                                                   |
| `SearchBar.ts`           | 24–42   | manual `setTimeout` debounce with id stored on the instance and cleared in `disconnectedCallback`                        | use a small typed `debounce()` utility with a single `controller.abort()` cleanup; or move to a `Task`-driven debounced search if the rest of the view migrates                                                                    |
| `TaskGroupList.ts`       | 623     | `this.requestUpdate()` in progress view                                                                                  | same — move underlying mutation to a reactive store                                                                                                                                                                                |

The pattern fix is consistent across all six: replace a non-reactive
field + `requestUpdate()` pair with a `@state()` field. Where the source
of truth lives outside the component (the `ViewState` container in the
history list, the underlying signal store), the migration is to make
that container's reads observable — either via the existing
`SignalWatcher` already in use at `MainApp.ts:381` and
`ProgressApp.ts:450`, or by extracting a small `@lit-labs/signals`
adapter.

`MainApp.ts` and `ProgressApp.ts` already use `SignalWatcher` correctly;
new components in this PRD's surface (the team picker, the agent picker,
the roster strip, the team editor) follow that pattern from day one.

### CSS consolidation

Rule: **shared visual primitives live in shared modules. Tab files
contain only tab-specific layout.**

Today, eight tabs duplicate the same six primitives. The audit
identified the exact selectors and line numbers; this PRD codifies which
modules absorb them.

Shared modules in `src/settingsView/frontend/`:

| Module                              | Exposes                                                                                         | Absorbs                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `styles.ts` (existing, expand)      | `.section-header`, `.tab-content`, `.action-button-row`                                         | `LaTeXTab.ts:339` `.section-header`, `ToolsTab.ts:183` `.category-header`, `GitTab.ts:76` `.section-title`, `MultiAgentTab.ts:458, 470` `<h3>` rules                                        |
| `cardStyles.ts` (new)               | `.settings-card`, `.settings-card-status-icon`, `.settings-card-body`, `.settings-card-actions` | `LaTeXTab.ts:186` `.dependency-card`, `LaTeXTab.ts:353` `.setting-card`, `MultiAgentTab.ts:64` `.preset-card`, `MultiAgentTab.ts:46` `.setting-block`, similar definitions in `ToolsTab.ts` |
| `badgeStyles.ts` (existing, extend) | `.badge`, `.badge-active`, `.badge-warning`, `.badge-error`, `.badge-source`                    | `LaTeXTab.ts:412` `.setting-badge`, `MultiAgentTab.ts:112` `.preset-active-badge`, `profile/styles.ts:235` `.key-status-badge`                                                              |
| `monoStyles.ts` (new)               | `.mono-path`                                                                                    | `AgentsTab.ts:131` `.agents-dir-path`, `LaTeXTab.ts:262` `.dependency-path`, similar elsewhere                                                                                              |
| `iconButtonStyles.ts` (new)         | `.icon-button`, `.icon-button-danger`                                                           | `AgentsTab.ts:156` `.agents-dir-icon-btn`, `MultiAgentTab.ts:288` `.preset-delete-btn`, hand-rolled link buttons in LaTeXTab                                                                |
| `emptyStateStyles.ts` (new)         | `.empty-state` + the `<settings-empty-state>` component declared in the consistency section     | new                                                                                                                                                                                         |

Tab files import what they need: `import { sectionHeaderStyles,
cardStyles } from '../styles';` and compose via Lit's `css\`\``
spreading.

The `profile/styles.ts` file (593 lines today) is shrunk by extracting
the same primitives. The `commonViewStyles.ts` file is the canonical
import for cross-webview shared CSS (used by progressView, mainView,
settingsView); settings-specific primitives live in
`src/settingsView/frontend/`.

### Handler idempotency

Rule: **handlers that touch related workspace state do so atomically or
explicitly accept partial-update semantics.**

The most visible offender is
`handleApplyAgentModePreset` at
`agentHandlers.ts:589–592`, which does two sequential
`workspaceSM.update` calls for `ENABLED_AGENTS` and
`ENABLED_TOOL_USE_AGENTS`. After this PRD, that handler no longer writes
to either key (Use selects a team without overwriting), so the pair
disappears. New handlers that need to update related keys use a small
batched API on `workspaceSM` (`updateMany([[k1, v1], [k2, v2]])`),
implemented as a sequential write with try/catch and rollback to the
prior values on failure. This is added in
`src/common/state/WorkspaceStateManager.ts` and used by team CRUD
handlers (`handleCreateCustomTeam`, `handleUpdateCustomTeam`,
`handleDeleteCustomTeam`).

### Component contracts for the new surfaces

Every new component in this PRD declares only `@property` (inputs from
parent) and `@state` (local UI state). No subclassing of
component-internal mixins; no `firstUpdated` for state initialization;
no `setTimeout`-driven property updates.

| Component                | Inputs (`@property`)                                                                    | Local state (`@state`)                                              | Events fired                                                     |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `<team-picker>`          | `teams: Team[]`, `selectedTeamId: string`, `modified: boolean`                          | `open: boolean` (dropdown open)                                     | `team-change`, `new-team-clicked`                                |
| `<agent-picker>`         | `agents: AgentEntry[]`, `team: Team`, `selectedAgentId: AgentRef`, `outOfTeam: boolean` | `open: boolean`                                                     | `agent-change`, `manage-agents-clicked`                          |
| `<roster-strip>`         | `team: Team`, `override: SessionTeamOverride \| null`                                   | (none)                                                              | `roster-add`, `roster-remove`, `save-as-team`, `reset-overrides` |
| `<team-editor>`          | `team: Team \| null` (null = new), `agents: AgentEntry[]`                               | `draft: Team`, `saving: boolean`, `validationError: string \| null` | `team-saved`, `cancelled`                                        |
| `<settings-empty-state>` | `icon: string`, `text: string`, `actionLabel?: string`, `actionEvent?: string`          | (none)                                                              | event named by `actionEvent`                                     |

All components live in `src/settingsView/frontend/components/` (team
editor + roster strip + empty state) or
`src/webview/frontend/components/` (team picker + agent picker, since
they render in the launcher). They are pure Lit elements and importable
by either webview without coupling to webview-specific stores.

### What this section does not require

This PRD does not require a full webview rewrite, a state-management
library swap, or a CSS framework adoption. The consolidations above are
small, mechanical, and can ship incrementally:

1. Extract `cardStyles.ts` and update LaTeX, Multi-Agent, Tools to import
   it. (~30 minutes)
2. Extract `.section-header` to `styles.ts`. Delete the three
   duplicates. (~10 minutes)
3. Migrate the six imperative violations one at a time. Each is a
   self-contained PR. (~10 minutes each)
4. Add `<settings-empty-state>` and adopt it in the four tabs that need
   it. (~30 minutes)
5. Add modal confirms to the four destructive paths. (~20 minutes total)

The new components for the launcher / Multi-Agent tab redesign follow
the contracts above from the start and do not contribute to the debt.

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
