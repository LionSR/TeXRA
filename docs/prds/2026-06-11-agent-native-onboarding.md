---
created: 2026-06-11
updated: 2026-06-11
---

# PRD: Agent-Native Onboarding — One Funnel, Three Surfaces

## Status: Draft

## Relationship to other PRDs

This PRD supersedes the onboarding slice of
`docs/prds/2026-04-30-launcher-and-onboarding.md` (the "Setup is a peer" /
first-run-landing parts) and is deliberately smaller than it. It does
**not** touch that PRD's team-first launcher, roster strip, or team
editor — those remain future work. Everything here is a stepping stone
toward that design, not a fork from it: the setup conversation becomes
the Setup team's session, and the orchestrator-by-default becomes the
default team's lead.

---

## Problem

A first-time user is overwhelmed before their first run, and the three
surfaces that could help them disagree with each other.

**The extension launcher shows everything at once.** In workflow mode:
an Interactive/Workflow radio, the agent dropdown (7 built-in workflow
agents, 16 built-in tool-use agents, plus the remote roster after
sign-in — `getVisibleAgents` shows _all_ agents when visibility was
never configured, `agentRegistry.ts`), the model dropdown, a Files
panel with three groups (Input/Context/Media, each with its own picker
and four buttons), and a LaTeX Diffs section with three more dropdowns.
Roughly eight dropdowns and fifteen buttons before the user types a
word. Agent names are raw YAML identifiers (`correct`, `merge`,
`creator`) with descriptions hidden in hover tooltips.

**Four banners compete with no coordination.** `GettingStartedBanner`,
`LoginBanner`, `ApiKeyBanner`, and `DependencyBanner` are independent
components with independent visibility rules. A credential-less user
can see several at once, each proposing a different next step.

**The CLI already solved the credential step — alone.**
`packages/cli/src/onboarding/runOnboarding.tsx` gates the interactive
entry points with a two-choice picker (relay sign-in recommended /
provider API key / explicit skip), modeled on Claude Code. The
extension never got the equivalent; its sign-in story is one banner
among four.

**The docs are a third funnel that disagrees with the other two.**

- `docs/guide/quick-start.md` leads with "Set Up API Keys" via the
  settings dashboard — the manual path first; Researcher Access
  sign-in is not in that section. The CLI recommends the opposite
  order.
- The canonical "first agent" has three competing answers:
  `docs/guide/first-run.md` teaches `polish`; the in-product
  walkthrough (`resources/walkthroughs/getting-started.md`) says the
  orchestrator is "the easiest way to start" in its lede and "run the
  Setup Assistant Agent" as the quickest path, then lists an 11-step
  manual checklist that duplicates what the setup agent does.
- "Setup" means two different things: CLI `texra setup` is the
  credential picker; the extension's "Run Setup Assistant Agent" is a
  conversational agent.

**The product already contains its own answer.** The `setup` agent
(`resources/tool_use_agents/setup.yaml`) has `probe_environment`,
`set_api_key`, `send_to_terminal`, arXiv tools, and
`delegate_agent`/`delegate_workflow` — it can configure the
environment _and run the user's first task_. The orchestrator answers
"which of these 23 agents do I pick?" by picking for you. Neither is
the default experience.

---

## Principle

> **Onboarding is a conversation with an agent. Static UI exists only
> where an agent literally cannot act yet — before there is a
> credential.**

Two corollaries:

1. **One funnel spec, three surfaces.** Extension, CLI, and docs render
   the same three-state funnel. Copy, choice order, and
   recommendations are defined once and imported, not paraphrased.
2. **Docs explain; product does.** The docs site and walkthrough
   narrate the funnel and stop being parallel funnels with their own
   orderings.

The one-line narrative every surface hangs off:

> **Setup is the doorman, polish is the demo, the orchestrator is the
> habit.**

---

## The funnel

State is _derived_, never a mode the user (or code) sets:

| State                    | Condition                                       | Meaning                                   |
| ------------------------ | ----------------------------------------------- | ----------------------------------------- |
| **0 — needs credential** | no usable credential, not previously declined   | The one step no agent can do for the user |
| **1 — setup**            | credential present, first run not yet completed | The setup agent owns the session          |
| **2 — done**             | a run has completed (or setup handed off)       | Normal product, good defaults             |

Derivation lives in one host-neutral module (see Implementation
surface) built from the pieces the CLI already has
(`credentialStatus.ts`, `onboardingState.ts` declined flag) plus a
`firstRunDone` global flag set when any run completes or the setup
agent hands off.

**All three inputs are user-scoped** (global state / secrets — where
the CLI already keeps credentials and the declined flag), never
workspace-scoped. This is what keeps a veteran who opens a brand-new
folder in State 2: onboarding is a fact about the _user_, and a fresh
workspace must never demote them to State 0/1. Workspace facts (empty
folder, no roster keys) shape only the project-bootstrap affordance
below, never the funnel.

### State 0 — one card, two choices

The extension/desktop launcher renders a single welcome card — a port
of the CLI picker, not a new design:

1. **Sign in — free for academics (Researcher Access)** _(recommended)_
2. **Use your own provider API key**
3. _Skip for now_ (quiet link; persists the same declined flag the CLI
   uses)

While in State 0 this card **replaces** the login, API-key, and
getting-started banners. Agent picker, model picker, Files, and LaTeX
Diffs are not rendered — they are meaningless without a credential.
The CLI keeps its existing picker unchanged; it is already the
reference implementation.

### State 1 — the setup agent owns the session

The moment a credential lands (in the same process — the CLI already
re-reads availability without restart; the extension does the same on
its credential-changed event):

- **Extension:** the launcher auto-selects the `setup` agent and
  kicks off the conversation.
- **CLI:** on true first run, the post-picker continuation enters chat
  **with the setup agent selected** instead of the bare launcher.

The setup agent conversationally covers what is today four banners,
five walkthrough links, and a settings tab:

- probes the environment and fixes missing LaTeX tooling
  (`probe_environment`, `send_to_terminal`) — the dependency banner
  disappears from onboarding;
- asks _"what are you working on?"_ and applies the matching roster
  via a new **`apply_team`** tool over the existing
  `AGENT_MODE_PRESETS` (the discipline-picker UI is never built);
- offers the first task: _your own draft / sample project / Overleaf /
  arXiv_ — the `GettingStartedBanner` links become things the agent
  does;
- runs the demo: a `polish` pass on the chosen file via
  `delegate_workflow`, ending at a diff — the same five-minute loop
  `docs/guide/first-run.md` teaches;
- hands off: names the orchestrator as the daily driver and sets
  `firstRunDone`.

### State 2 — defaults so good the dropdowns don't matter

- Default agent: **orchestrator** for signed-in users (the
  agent-native answer to "too many agents" — the concierge routes);
  **chat** for BYOK users (the orchestrator is relay-served).
- The dropdowns stay where they are. A first-timer never had to touch
  them; a power user loses nothing.
- The API-key banner survives only for its real job: "the model you
  just selected needs a key you don't have." The login banner survives
  only as a low-key upsell for BYOK users.

### State 2 in a fresh folder — project bootstrap, not onboarding

A user who finished setup and opens a new, empty folder is the
_returning user_ case, and it must feel like starting a project, not
starting over:

- **No welcome card, no setup auto-start** — funnel state is
  user-scoped (above), so they are in State 2 regardless of the
  folder.
- **Extension:** the `GettingStartedBanner` is demoted from a headed
  five-link list to one slim, dismissible row, shown only when the
  workspace has no LaTeX files (its existing trigger): _"Empty folder
  — Sample project · Pull from Overleaf · Grab from arXiv — or just
  ask below."_ The links are the existing commands; "ask below" works
  because the default agent can do the same things conversationally.
- **CLI:** `texra init` already is the per-project bootstrap (writes
  the workspace config, picks default agent/model). The empty-dir
  chat greeting mentions it; nothing new is built.
- **Roster in the new workspace:** seeded from the user-level default
  team (next section), so their discipline choice follows them into
  every new project instead of resetting to a generic set.

---

## Dropdown hygiene (ships with the funnel, useful without it)

1. **Default team seeds new workspaces.** One user-scoped key —
   the same `defaultTeamId` concept as the launcher PRD — written when
   the setup agent's `apply_team` runs (a generic "starter" team if
   the user skips the discipline question: workflow `correct`,
   `polish`; tool-use `chat`, `research`, `review`, `latexFixer`,
   `setup`, plus the orchestrator entry once signed in). When a
   workspace has no `ENABLED_AGENTS`/`ENABLED_TOOL_USE_AGENTS` keys,
   activation seeds them from the default team; absent a recorded user
   default, the built-in Physicist team is used so new startup menus do
   not expose the full catalog.

   This replaces install-detection heuristics entirely: pre-existing
   users get the built-in Physicist roster in fresh folders unless they
   already configured a workspace roster; post-setup users get their
   chosen roster in every fresh folder. `filterVisible` semantics are
   untouched, and Settings → Agents already shows non-roster agents as
   unchecked — discoverable and reversible with shipped UI.

2. **Canonical agent labels.** Agent dropdowns use the YAML `name` as
   the only picker label; the description field carries explanatory text.
3. **"Browse all agents…" tail item** in the agent dropdown → opens
   Settings → Agents (handler exists). The docs counterpart of this
   destination is `docs/guide/built-in-agents.md`, the full catalog.

---

## Vocabulary

| Term      | Means                                                | Stops meaning             |
| --------- | ---------------------------------------------------- | ------------------------- |
| **login** | getting a credential (Researcher Access or API key)  | —                         |
| **setup** | the agent-led flow (environment, roster, first task) | the CLI credential picker |

Concretely: CLI `texra setup` becomes the agent-led flow (credential
picker first if State 0, then the setup agent); `texra login` keeps
credentials-only. A deprecation note covers the transition.

---

## The narrative contract (docs + product, one story)

| State | Extension / desktop       | CLI                        | Walkthrough beat                              | Docs page                                                             |
| ----- | ------------------------- | -------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| 0     | welcome card              | first-run picker (shipped) | "Sign in — free for academics — or add a key" | `first-run.md` step 0; `quick-start.md` lead                          |
| 1     | setup card → click to run | setup agent after picker   | "The setup assistant takes it from here"      | `first-run.md` body (polish demo, agent-run or manual)                |
| 2     | orchestrator default      | orchestrator/chat default  | "Meet the orchestrator"                       | `quick-start.md` (launcher reference), `built-in-agents.md` (catalog) |

Doc changes:

- **`quick-start.md`:** the leading "Set Up API Keys" section becomes
  "Sign in or add a key" with the shared choice order (sign-in
  recommended first). The per-provider API table moves to
  `configuration.md`/`models.md` as reference. The rest of the page
  remains the State 2 launcher reference.
- **`first-run.md`:** keeps the polish demo (it _is_ the demo), gains
  the funnel's step 0, and notes that on a fresh install the setup
  agent offers to run exactly this.
- **Walkthrough (`resources/walkthroughs/getting-started.md`):** three
  beats matching the table; the current 11-step checklist is demoted
  to a "prefer to do it manually?" appendix. It stops rotting because
  the agent owns the details.
- **`built-in-agents.md`:** unchanged in role — it is the catalog the
  "Browse all agents…" affordance points to.

Copy that appears in product surfaces (choice labels, recommendation,
skip text) lives in `src/shared/copy/onboarding.ts` (next to the
existing `promoNotice.ts`) and is imported by the CLI picker, the
extension card, and the walkthrough-generation source. Docs prose
mirrors it; this PRD's State 0 wording is the canonical text.

---

## Explicit non-goals (cut for simplicity)

- No `launcherMode` simple/full flag — state is derived from
  credential + first-run facts.
- No merged session-type/agent picker, no model chip, no files chip —
  UI consolidation belongs to the launcher PRD.
- No discipline-picker UI — the setup agent asks in conversation.
- No team machinery, roster strip, or team editor changes.
- No change to headless paths: `texra run`, `--print`,
  `--output-format` never see onboarding (the existing TTY-only gate
  already guarantees this; the extension equivalent is webview-only by
  construction).

---

## Edge cases and migration

- **Existing users:** upgraders never see the welcome card (they have
  credentials and/or run history; `firstRunDone` is backfilled at
  migration when either exists). Fresh workspaces get the built-in
  Physicist roster until the user records a different default team.
- **Finished setup, fresh folder:** State 2 (funnel state is
  user-scoped); slim bootstrap row + default-team roster seeding (see
  "State 2 in a fresh folder"). Never the welcome card or setup
  auto-start.
- **Skip:** the declined flag suppresses State 0 on subsequent
  launches (CLI behavior today, extended to the extension card's
  dismiss). `texra login` / the card-reachable settings remain the
  recovery path; configuring a credential clears the flag (CLI already
  does this).
- **BYOK State 1:** the setup agent runs fine on a provider key; only
  `apply_team` choices that require remote agents (e.g. orchestrator
  leads) are presented as "after you sign in" rather than silently
  failing.
- **Setup agent re-entry:** `setup` stays in the curated roster, so
  returning users can re-run it from the dropdown (matches the
  launcher PRD's "Setup is a peer").
- **Desktop host:** consumes the same webview controllers; the
  welcome card and auto-start ride along.
- **`AgentConfigBanner`:** unrelated to onboarding; unchanged.

---

## Implementation surface

| Concern                                                               | Files                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Funnel state derivation (host-neutral)                                | new `src/controllers/onboarding/` module; lift `packages/cli/src/onboarding/onboardingState.ts` + `packages/cli/src/runtime/credentialStatus.ts` logic behind `@platform`                 |
| Shared copy                                                           | new `src/shared/copy/onboarding.ts`; consume in `runOnboarding.tsx`, new welcome card, walkthrough source                                                                                 |
| Welcome card (extension/desktop)                                      | new component in `packages/extension/src/webview/frontend/components/`; visibility wiring in `BannerGroup.ts` / `MainApp.ts`                                                              |
| State 0 → 1 handoff                                                   | extension credential-changed event → select `setup` (launch is an explicit "Run setup assistant" click, never auto-started); CLI post-picker continuation in `chat.ts` / `orchestrate.ts` |
| `apply_team` tool (writes workspace roster + user-level default team) | new tool in `src/tools/`; preset application path exists in `SettingsAgentCatalogController.ts`                                                                                           |
| Default-team seeding of fresh workspaces                              | user-scoped `defaultTeamId` key (shared with launcher PRD), starter team in `agentRegistryConstants.ts`, seeding at activation in `packages/extension/src/extension.ts` and CLI init      |
| Project-bootstrap row (empty folder, State 2)                         | `GettingStartedBanner.ts` slimmed; trigger condition unchanged                                                                                                                            |
| "Browse all agents…" tail item                                        | `selectTemplates.ts`, `InstructionPanel.ts`                                                                                                                                               |
| State 2 defaults                                                      | `agentRegistryConstants.ts` preferred lists (orchestrator/chat already first); default-selection logic in launcher controller                                                             |
| Vocabulary (`texra setup`)                                            | `packages/cli/src/commands/setup.ts`                                                                                                                                                      |
| Walkthrough rewrite                                                   | `packages/extension/resources/walkthroughs/getting-started.md`                                                                                                                            |
| Docs site                                                             | `docs/guide/quick-start.md`, `docs/guide/first-run.md`, `docs/guide/configuration.md`                                                                                                     |

### Suggested shipping order

1. **Hygiene** (independent, zero-risk): canonical agent labels,
   "Browse all agents…", slimmed bootstrap row.
2. **State 0 on the extension**: shared copy module + welcome card
   replacing three banners; CLI unchanged.
3. **State 1**: on credential arrival, select `setup` and show the setup
   card (both hosts); the user launches it with an explicit "Run setup
   assistant" click — never auto-started. Plus `apply_team` tool +
   default-team seeding of fresh workspaces, setup-prompt additions,
   `texra setup` vocabulary fix.
4. **Narrative**: walkthrough rewrite + docs-site edits (can trail by
   a release, but must land before marketing the flow).
