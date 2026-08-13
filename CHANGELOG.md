# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### CLI

#### Bug Fixes

- **Completed workflow tasks can be retried without restarting chat** — a new
  workflow attempt may reuse its saved task identity after the previous
  attempt has delivered its result.
- **CLI tables preserve long mathematical expressions** — narrow columns wrap
  LaTeX formulas and other indivisible values instead of replacing their tails
  with an ellipsis.
- **Delegation approvals distinguish one task from chat-wide access** — proposal
  cards now state that `y` approves only the visible task, while `a` also
  approves later agent tasks, file edits, and commands in the chat.
- **Direct approval prompts reveal complete proposals and edits** — when a
  compact preview hides instruction or diff lines, press `v` to inspect the
  full content before approving or rejecting it.
- **Session status reports active delegated work** — `/status` now shows the
  number of active background tasks while retaining the focused session's own
  status.
- **Interrupted multi-agent chats can be resumed immediately** — leaving a
  cancelled team session no longer leaves its printed resume command
  temporarily unavailable.
- **Workflow footers show only usable controls** — focused workflows and
  background processes no longer advertise slash commands while their chat
  input is hidden.
- **Session views show recognizable model names** — headers, `/status`, and
  background-task rows use catalog labels instead of internal model IDs.
- **Workflow task progress shows recognizable model names** — focused
  dashboards, interactive transcripts, and headless progress use catalog
  labels instead of internal model IDs.
- **Workflow reruns show current task progress** — retrying a saved workflow no
  longer counts completed or failed task states from earlier attempts in the
  live dashboard.
- **Workflow dashboards identify blocked tasks** — a task waiting for approval
  now shows the pending approval kind on its own row.
- **Interrupted headless agent runs show how to resume** — stopping a tool-use
  agent or multi-agent team now prints a command that preserves its workspace,
  approval policy, and skill sources while reopening the interactive session
  required for continuation.
- **Headless team progress identifies delegated tasks** — direct multi-agent
  runs show what the active child is checking, not only its generic agent name.

### Extension (VS Code) and Desktop

#### Bug Fixes

- **Delegation approvals state their full run-wide scope** — approval controls
  no longer imply that later automatic approvals are limited to tasks requested
  by one agent.

### Shared (all surfaces)

#### Bug Fixes

- **Read-only completion checks stay focused** — end-of-session review no
  longer asks to inspect project plans, Git history, or pull requests when the
  current task and its delegated results already contain the evidence needed.
- **Tool-use chats no longer show misleading round jumps** — internal model
  and tool calls no longer appear as skipped user-visible rounds after a chat
  continues or resumes.
- **Concurrent app starts refresh bundled agents safely** — simultaneous TeXRA
  processes sharing one data directory no longer fail while updating built-in
  agent definitions.
- **Claude Code forks leave the original conversation unchanged** — an
  incomplete fork now stops instead of continuing the original conversation.

## [0.40.2] - 2026-08-12

### CLI

#### Features

- **`/plan` shows the full work plan** — unfinished todos stay visible after a
  run waits or finishes, and `/plan` opens the objective and todo list.
- **Coding-plan quota appears in the status bar** — when a Kimi or GLM coding
  plan is in use, the bar shows how much remains.
- **Terminal tabs show when a session is running** — an active run is visible
  from the tab without switching to it.

#### Bug Fixes

- **Interrupted workflows resume right away** — a stopped workflow appears in
  history as resumable immediately. If resume fails, you get an explanation
  instead of a silent exit.
- **Narrow terminals still show every approval choice** — including the option
  to approve all agent work in this chat.
- **Follow-up input appears only when it will work** — background tasks that
  cannot take a follow-up no longer show a follow-up box.

### Extension (VS Code) and Desktop

#### Features

- **Each run shows the skills it is using** — a collapsible list on the
  session.
- **Session rows say what they are doing** — running, waiting, completed,
  failed, cancelled, or waiting for approval, not only a colored bar.
- **Workflow approvals name the workflow and its scale** — the workflow name,
  how many tasks it will run, and a cost warning.
- **Failed workflow tasks show up in the status line** — even if the workflow
  itself finished.

#### Bug Fixes

- **Deleted sessions no longer keep their background tasks** — those tasks
  remain as their own sessions instead of staying nested under a session you
  removed.
- **Long session histories stay responsive** — large workspaces no longer
  hitch when you change theme or browse history.
- **Background-task status uses the same words as the rest of the view** —
  Running, Idle, Completed, Stopped, and Error. Rejection notes no longer
  leave empty space.
- **Session names stay correct after a reload** — they no longer go blank or
  revert to a stale title.

### Shared (all surfaces)

#### Features

- **Subscription usage is visible** — Settings and the CLI show remaining
  ChatGPT, Kimi Code, and GLM Coding Plan quota. You cannot choose Included
  Access when that allowance is used up. An exhausted coding plan switches
  back to your API key.
- **Context compaction is visible** — the transcript shows when a conversation
  is being compacted and how it finished.
- **Payment labels are shorter in tight spaces** — "Included" and "API keys",
  with the full names still available to assistive technology.
- **Claude Code background work is visible** — and its cost is included in
  usage.
- **Writing and review agents sound more human** — they drop generic AI
  phrasing. Agents that only edit or check files are unchanged.

#### Bug Fixes

- **OpenAI overload errors retry automatically** — instead of failing the run.
- **Withdrawn models leave your enabled list** — on the next launch, without
  turning other models back on.
- **Deleted sessions no longer leave leftover files behind** — leftover run
  data is cleaned up on the next launch.

## [0.40.1] - 2026-08-08

### CLI

#### Features

- **The TUI exit summary shows session cost and payment route** — leaving a
  chat session now reports how much it cost and how it was paid for.
- **The model catalog is reachable from the TUI** — browse and enable models
  without leaving the chat interface.
- **The transcript reader pages with `PgUp`/`PgDn`** — the Ctrl-T full-output
  view scrolls a page at a time instead of one line per keypress.
- **The status bar reports how many sessions are running** — while background
  sessions are in flight, the status bar declares the count (e.g. "3 running
  sessions") alongside the Tab sessions hint.
- **GLM Coding Plan access** — GLM models can be used through a GLM Coding
  Plan subscription, with the access mode and picker status shown in the CLI.

#### Bug Fixes

- **Live transcript updates are restored and Ctrl-T is closable** — the
  transcript viewer no longer goes stale while a run streams, and the full
  tool-output view can be dismissed again.
- **TUI blocking UX defects are fixed** — approval, retry, and login flows no
  longer block the interface, and nested runs are consistently described as
  "background tasks".
- **TUI polish** — doubled blank rows between transcript entries are gone,
  retired streams no longer re-activate after `/clear`, hints are truthful,
  links are reachable, and errors and warnings have a non-colour cue.
- **The approval-denied exit code is retired** — a denied approval gate is no
  longer reported as a failed run; the CLI warns once on stderr instead.
- **Grok follow-ups work from the TUI** — Grok subscription sessions handle
  follow-up messages correctly.
- **CLI approval modes govern Bash commands and file edits consistently** —
  `never` denies them even when a prompt setting or stream bypass would allow
  them, while automatic approval permits them without opening a prompt.

### Extension (VS Code) and Desktop

#### Features

- **Desktop renderer accessibility and copy fixes** — icon-only buttons are
  named, tab strips follow APG keys, terminal focus and screen-reader mode
  are wired, the command palette is a proper combobox, and high-contrast
  colours and placeholder contrast are repaired.

#### Bug Fixes

- **New Subscriptions settings tab** — ChatGPT subscription, Copilot in VS
  Code, and Kimi Code setup now live together under Account instead of being
  split across Account and Providers & Models.
- **Settings status indicators share one visual language** — a green check
  for set values and a neutral "Not set" tag everywhere, with shared styles
  and icons across all tabs.
- **The sidebar tabs are now "New" and "Sessions"** — the redundant
  "Sessions" heading is gone, and an idle session reads "Idle" instead of
  "Waiting for follow-up".
- **The session view is decluttered** — stray blank bands are removed, the
  close button is quieter, the redundant subscription tooltip is dropped, and
  session rows are more compact.
- **The Copilot section no longer shows a wall of buttons** — per-model route
  controls collapse behind a "Manage Copilot routes" disclosure.
- **Session reliability controls moved to the Agents tab** — compaction
  threshold and automatic retries now live with agent configuration, and
  tool-use agents list before workflow agents.
- **Nested runs are named "background tasks"** — one consistent name across
  the extension, desktop, and CLI, with session labels declared from
  RunIdentity.
- **Review follow-ups and approvals are fixed** — file-row clicks dispatch
  correctly, approvals are labelled with their run, and Approve/Reject stay
  on screen in a dedicated approval dock.
- **Accessibility is restored** — every control is named and exposes its
  state, the shared focus ring is back, non-colour status cues are added, and
  the WorktreeChip uses the shared visually-hidden helper.
- **Token and colour fixes** — variant contrast, the light-terminal palette,
  muted/border tokens, resolving custom properties, and opacity stacking are
  repaired.
- **The composer sizes from its content** — the follow-up input rests at two
  lines and grows with the draft, and the Followup collapsible is restored on
  VS Code.
- **The approval policy is re-seeded on rollback/reset** — workspace
  transitions re-read the effective persisted policy instead of leaving a
  stale value.
- **Optional tools and Lean inspection** — missing optional external tools
  stay quiet, and `lean_inspect` failures surface instead of being dropped.
- **LaTeX and retry polish** — custom LaTeX replacements reuse the canonical
  Zod schema, and long retry error messages are no longer clipped.
- **Model access has one name in every host** — the CLI, extension, and
  desktop describe model access consistently, and Vite 8 build warnings are
  resolved.

### Shared (all surfaces)

#### Features

- **Sign in with Grok (xAI SuperGrok) (Experimental)** — a new OAuth login
  flow lets you use an xAI SuperGrok subscription for Grok models, alongside
  the existing ChatGPT and Kimi Code subscription options.
- **GitHub App OIDC for Actions reviews** — code-review workflows can now
  authenticate through a GitHub App using OpenID Connect token exchange, so
  reviews post as the app instead of requiring a personal access token.
- **Per-stream call counts and subscription equivalent cost** — usage
  tracking now records how many model calls each stream made and prices
  subscription rounds at their list-price equivalent.
- **DeepSeek V4 Flash (Thinking) joins the default model list** — the
  thinking variant of DeepSeek V4 Flash is now available by default in the
  model picker.
- **GLM-5.2 joins the default model list** — GLM-5.2 is now available by
  default in the model picker alongside the other provider flagships.

#### Breaking Changes

- **The multi-agent orchestration tool is now `delegate_multi_agents`** —
  the tool formerly named `delegate_workflow_script` has been renamed with
  no compatibility alias. Custom agent YAML files that list
  `delegate_workflow_script` in their tool list must use the new name.
- **Retired Claude model selections now use the current default** — saved
  Opus 4.7 or 4.8 selections are no longer translated to Opus 5.

#### Bug Fixes

- **Transient-HTTP-status classification is shared with arxivProcessor** —
  arXiv downloads and LaTeX processing now agree on which HTTP statuses are
  transient, so retries behave consistently.
- **`delegate_multi_agents` describes both workflow and tool-use agents** —
  the tool's description and call guidance now cover both agent types it
  drives.
- **Legacy agent roster selection is repaired in place** — the old
  pair-shaped roster format no longer warns on every CLI startup; it is
  detected and normalized immediately.
- **Duplicate side-effect tool calls share one result** — identical
  side-effect calls in one batch execute once and share the result, so the
  model does not see skip errors or re-run the same side effect.

## [0.40.0] - 2026-08-02

### CLI

#### Breaking Changes

- **Final JSON results now use `outcome` as their only terminal-state field** —
  the deprecated `status`, `terminalStatus`, and `endGroupStatus` fields have
  been removed with explicit maintainer approval. Streamed NDJSON
  progress records are unchanged.

#### Features

- **Workflow runs have a phase-and-task dashboard** — the terminal shows
  canonical workflow progress, task status, model, elapsed time, generated
  tokens, and cost. Wide terminals provide separate navigable phase and task
  panes, while narrow terminals retain source order in one pane.

#### Bug Fixes

- **Account status is concise and unambiguous** — `/auth` and `/api status`
  now show model preferences, account identities, personal keys, and included
  usage once each instead of repeating the same access in several forms.
- **Automatic CLI runs stop after their model retry limit** — automatic
  approval mode no longer restarts another full retry sequence when every
  configured attempt has failed.
- **Escape backs out of nested agents one level at a time** — leaving a child
  now returns to its immediate parent before Escape can interrupt the root run.
- **Background workflow task lists start collapsed** — background plans take up
  less terminal space until their task details are needed.

### Extension (VS Code) and Desktop

#### Features

- **The follow-up composer is larger and resizable** — it starts at six lines
  and can be resized vertically for longer instructions.

### Desktop

#### Breaking Changes

- **The Codex and Claude Code CLIs are now installed separately** — the desktop
  app no longer ships its own copies, which accounted for well over half of its
  download size. If you used either integration from the desktop app without
  installing its CLI yourself, it will show as **Not Found** after upgrading
  until you install it once from **Dashboard → Integrations → Install in
  Terminal**. Anyone who already has the CLI — including every VS Code and
  terminal user, which never bundled them — is unaffected and needs no setup.

### Shared (all surfaces)

#### Features

- **The CLI, extension, and desktop app now share TeXRA settings** — project
  settings follow the project across all three surfaces, and user-wide desktop
  settings are shared with the CLI and extension. New releases use the shared
  defaults without importing older host-specific settings. Skills, telemetry,
  tool approvals, and LaTeX replacement rules now have native controls in the
  TeXRA settings view.
- **OpenAI Fast models use the priority service tier** — their requests now ask
  OpenAI for priority processing instead of the standard service tier.
- **Workflow scripts are available to the software-engineering and Lean team
  leads** — after enabling Workflow Script in the Tools panel, these teams can
  run predetermined parallel and sequential agent pipelines that resume safely
  after interruption.

#### Breaking Changes

- **Agent reviews now choose their own scope and depth** — the saved controls
  for including untracked files or submodules and choosing a quick or thorough
  approach have been removed. Reviews inspect the relevant change set directly.
- **File discovery now uses fixed product rules** — the removed
  `texra.files.included.*` and `texra.files.ignored.*` settings no longer change
  which workspace files TeXRA discovers. Remove those keys from project config
  files and old VS Code settings.
- **Agent definitions use only the current schema** — custom definitions must
  use `assistant` instead of the retired `chat` name and must remove obsolete
  settings such as `outputExt`, `documentTag`, `endTag`, `prefills`,
  `requiredFiles`, and `filePatternsContain`. TeXRA no longer translates or
  silently discards these historical fields when loading an agent.
- **Google sessions now use the current conversation service exclusively** —
  the obsolete Google compatibility toggle has been removed. Some Google
  sessions saved by earlier versions remain readable but cannot be resumed;
  start a new session to continue with a Google model.
- **Tool-use flow results use `response` and `files` consistently** — consumers
  of `@texra-ai/agent` and CLI JSON output should replace `lastResponse` with
  `response` and `touchedFiles` with `files`.
- **A run that ends over the model context window now reports its own error
  kind** — consumers of `@texra-ai/agent` that switch exhaustively over a
  result event's `error.kind` must handle the new `context-window` value, which
  previously arrived as `unexpected`.
- **Execution conversation pagination now uses messages rather than rendered
  lines** — callers of `/executions/{id}/conversation` should replace
  `view_range` with `offset` and `limit`. Responses report the returned message
  interval and next offset.

#### Bug Fixes

- **Failed latexdiff builds no longer flood the workflow log** — the visible
  warning identifies the affected diff file without dumping the LaTeX compiler
  transcript; the full diagnostic remains available in debug data.
- **Google models handle prompts and tool-enabled tasks reliably** — requests
  no longer fail when a prompt has no prefix or when complex tool sets are
  enabled.
- **Google background interactions resume across transient retries** — TeXRA
  reconnects to the existing interaction instead of losing its in-progress
  response.
- **OpenAI background responses keep one polling deadline across retries** —
  reconnecting to the same response no longer restarts its three-hour polling
  window. Once that window expires, TeXRA stops automatic retries and permits
  an explicit retry to start a new response.
- **Automatic model retry settings are bounded** — the retry setting now
  accepts zero to five additional attempts after the initial request. Invalid
  stored values fall back to the documented default instead of creating an
  arbitrarily long automatic retry sequence.
- **Stop requests are not lost between runtime stages** — interrupting as one
  stage finishes now also cancels the next model or tool operation instead of
  allowing the run to continue.
- **Runs that overflow the model context window say so** — instead of a generic
  failure message, the run now reports that the conversation exceeds the
  model's context window and suggests starting a new session or reducing
  attached files and tool output.
- **A missing OpenRouter API key offers the same setup prompt as every other
  provider** — it was reported as an unexpected failure rather than an
  actionable "set your API key" notice.
- **Compiled PDF artifact paths are correct on Windows** — diff PDFs generated
  from files in round subdirectories no longer repeat the round directory in
  their saved path.
- **Failed agent starts no longer look like successful runs** — when a new
  launch cannot start on a previously completed task, the status update is now
  identified as a rollback rather than a fresh completion.
- **Agent failures retain their partial result** — the original error is now
  reported together with any partial response and affected files.
- **Long-running sessions use less memory after recovering interrupted runs** —
  transcript history loaded only to repair stale run state is released again
  after the repair is saved, instead of remaining in memory for the rest of
  the session.
- **Workspace switches apply settings and storage together** — a session can no
  longer observe the new workspace with stale settings or storage from the
  previous one during the transition.
- **Snapshot save failures surface without losing queued updates** — writes stop
  after bounded retries and report the failure while preserving pending updates
  and their order for recovery.
- **Install in Terminal now offers a command your machine can run** — the Codex
  and Claude Code cards offer the Homebrew command where Homebrew is present
  and Claude Code's Windows installer on Windows, instead of a global npm
  install that fails without Node. The desktop app's terminal also picks up
  Homebrew and `~/.local/bin` now, so a command it suggests no longer fails
  with `command not found` when the app was launched from the Dock or Finder.
- **Claude Code installed by its native installer is found again** — the
  desktop app now looks in `~/.local/bin`, where the installer recommended by
  Anthropic's docs puts it, instead of reporting the CLI as missing.
- **Claude Code on Windows is no longer detected as a broken install** — a
  global npm install leaves only shell shims that TeXRA cannot run, so it is
  now reported as not installed, with setup instructions, rather than
  appearing available and failing when an agent calls it.

## [0.39.11] - 2026-07-29

### Shared (all surfaces)

#### Bug Fixes

- **Fixed a crash on startup** — the CLI no longer exits with a module
  loading error before running any command; the same defect would have
  crashed the VS Code extension on activation and the desktop app on launch.
  The 0.39.10 CLI release is affected; please upgrade.

## [0.39.10] - 2026-07-29

### Shared (all surfaces)

#### New Features

- **Embeddable agent package** — Node applications can install
  `@texra-ai/agent`, load agents from a chosen directory, stream run events,
  and await the final result.
- **Predictable embedded model output** — the agent package now returns
  provider text unchanged and joins continued responses deterministically,
  while TeXRA applications retain their LaTeX-aware processing.

#### Bug Fixes

- **Consistent workflow progress** — workflow rounds and task states now use
  the same numbering and wording in the terminal, desktop, and VS Code.
- **Visible headless workflow progress** — workflow scripts launched by
  non-interactive runs now print phase, task, and completion progress; workflow
  task cards open their child runs directly without a duplicate background-task
  panel.
- **Concise workflow results** — completed workflow scripts now render one
  shared summary of phases, tasks, generated files, cost, duration, and rerun
  instructions instead of repeating the full run log.
- **Interrupted runs no longer look stuck** — runs cut off by a crash or
  force-quit are marked as interrupted when the session reopens, instead of
  appearing to run forever.
- **Accurate usage totals** — a malformed usage update can no longer silently
  reset a run's accumulated token and cost totals to zero.

### CLI

#### New Features

- **First-run handoff explained** — after the initial credential setup, the
  chat session explains that the setup assistant is guiding the first run and
  that `/agent` switches to another agent anytime, using the same wording as
  the setup card in VS Code and the desktop app.

#### Bug Fixes

- **Leftover runs are cleaned up** — opening a CLI session removes runs left
  behind by earlier interrupted sessions, matching the VS Code and desktop
  behavior.

### Extension (VS Code) and Desktop

#### New Features

- **Tidier progress view** — stream tabs are denser and the follow-up input is
  larger, with the unused tab filter and clear-input controls removed; the
  multi-agent settings now show a single combined Teams block.

#### Bug Fixes

- **Clearer account status** — an expired sign-in no longer shows as
  "Connected"; the Account settings tab now shows a "Session expired" warning
  with a sign-in prompt and surfaces server spending-check failures.

### Desktop

#### Bug Fixes

- **Every session appears in the sidebar** — sessions no longer disappear from
  the desktop sidebar because of a category filter saved in the progress view.
- **Missing agents are flagged** — the desktop app now shows a banner when a
  task references an agent that is not configured.
- **Unsaved edits are protected** — the desktop app asks for confirmation
  before closing the window or switching workspaces with unsaved file changes,
  and canceling the close no longer loses those changes.
- **Reloading the window no longer leaks sessions** — terminal and browser
  sessions are cleaned up across reloads instead of being left behind.

## [0.39.9] - 2026-07-26

### Shared (all surfaces)

#### New Features

- **Agent skills controls** — enable or disable TeXRA and imported skills from
  the CLI, VS Code, or desktop settings.
- **Claude Opus 5 support** — Opus 5 is now available and replaces Opus 4.8 as
  the default Anthropic model.
- **Live background command output** — agents can inspect a command's output
  while it is still running.
- **Workflow phase progress** — running workflow scripts show their current
  phase in the CLI and progress view.

#### Bug Fixes

- **Correct Claude effort levels** — effort choices now match each model's
  supported tiers.
- **Accurate workflow task costs** — each task now shows its own cost rather
  than the workflow's cumulative cost.
- **Custom team compatibility** — teams with older icon data no longer
  disappear from the catalog.
- **Long Claude sessions recover automatically** — when a session reaches its
  context limit, TeXRA compacts the conversation and continues the run.
- **Reliable large command output** — long foreground shell commands no longer
  consume unbounded memory.

### Extension (VS Code) and Desktop

#### Bug Fixes

- **Bounded terminal scrollback** — long terminal-mode logs retain recent
  complete lines and indicate when older output has been removed.

### Desktop

#### New Features

- **The desktop app now centers every task around its conversation** — projects
  and task history stay in a quiet sidebar, while files, terminals, browser
  pages, logs, and settings open in a resizable workbench without replacing the
  task.
- **The launcher and transcripts use a unified desktop design** — the new
  neutral theme, compact activity cards, persistent composers, consistent
  controls, and stroke icons make setup, execution, and follow-up feel like one
  coherent application.
- **The starter-team chooser now opens in the task canvas at startup** — it no
  longer blocks the app as a modal, and users can save a preference to hide it
  on later launches.
- **Project files now follow their folder hierarchy in the sidebar** — nested
  folders expand in place, keep their open state while the list refreshes, and
  show concise file names instead of flattened paths.
- **Settings now use a responsive top navigation** — account identity, sign-in,
  included usage, and credential access have a dedicated Account & Usage page,
  while a compact category-and-page hierarchy keeps the remaining settings
  reachable without an overflowing row of tabs. Every page now follows the
  same heading, section, banner, control-row, and responsive layout.
- **Desktop keyboard shortcuts are now customizable** — users can search,
  reassign, clear, and restore bindings from a dedicated settings page, with
  changes applied immediately.
- **The task toolbar now includes an environment summary** — a compact floating
  panel shows workspace changes, branch status, active agents, background
  terminal state, and attached sources without duplicating their controls.
- **Requested file changes now open in a Review workbench** — changed files are
  grouped by folder beside an in-app diff, with per-file and total line counts
  for inspecting an agent's proposed edits.
- **Desktop logs now provide an itemized live viewer** — entries refresh
  automatically, remain independently expandable, and keep refresh, copy,
  export, and folder actions in one toolbar.

#### Bug Fixes

- **The desktop development command launches the complete app** — it builds the
  Electron entry points, starts the renderer on an available local port, and
  opens Electron instead of leaving only a browser development server running.
- **The launcher no longer appears blank while startup state loads** — a visible
  loading canvas bridges startup, and send controls stay unavailable until the
  request, model, and agent or team are ready.
- **The desktop canvas now follows window resizing** — expanding the Electron
  window no longer leaves a fixed-size interface surrounded by empty space, and
  the project sidebar and workbench remain resizable.
- **Switching project folders no longer opens a blank desktop window** — the
  current app window restarts into the selected workspace while the development
  renderer remains available.
- **The startup chooser now hands off to a ready launcher** — skipping setup
  no longer leaves the task canvas on an empty loading state.
- **Project files appear as soon as a workspace opens** — the sidebar now loads
  text source files at startup instead of reporting an empty project until the
  editor is opened.
- **Desktop chrome behaves consistently on macOS** — the brand and task header
  align with the traffic-light controls, the collapsed-sidebar button stays
  clear of them, and development windows no longer follow every Space.
- **Workbench controls use one consistent hover shape** — panel shortcuts and
  editor, terminal, and browser tabs no longer show nested or mismatched hover
  backgrounds.
- **The task composer stays organized as its panel narrows** — session and
  runner choices, agent and model selectors, tools, and the centered send
  button now form clear responsive groups instead of colliding or drifting.
- **Files changed outside TeXRA refresh before editing** — switching back to a
  clean editor tab no longer risks saving an older cached copy over newer
  project changes.
- **Desktop editor access stays inside the open project** — linked paths can no
  longer be used to read or write files outside the workspace.
- **Desktop startup and narrow layouts remain usable** — onboarding adapts to
  split panes, tool information appears immediately while refreshing, and
  macOS window controls no longer collide with navigation.
- **Desktop sign-in stays in the system browser** — cancelling authorization
  returns safely to TeXRA instead of opening an embedded sign-in window or
  terminating the app.
- **The project tree and terminal match the surrounding workspace** — hovering
  a file no longer highlights every parent folder, tree icons sit close to
  their labels, and the terminal no longer has nested borders or a mismatched
  black container.

### CLI

#### New Features

- **Workflow phase views** — focused workflow runs group agents by phase and
  show per-phase task progress.
- **Clear workflow task states** — task rows distinguish planned, running,
  completed, skipped, and failed work.
- **Visible media inputs** — loaded images and PDFs appear in the terminal
  transcript.

#### Bug Fixes

- **Independent access preferences** — ChatGPT, Kimi Code, and API fallback
  choices no longer change one another unexpectedly.
- **Reliable post-launcher prompts** — sign-in and team availability prompts
  remain interactive after leaving the launcher.
- **Cleaner child list** — removed background-process rows that were always
  empty.

## [0.39.8] - 2026-07-24

### Shared (all surfaces)

#### New Features

- **The Mathematician team includes the critique workflow** — mathematical team
  runs can delegate a dedicated critical review directly.
- **The orchestrator agent can run scripted multi-agent pipelines** — the
  built-in Orchestrator supports planned fan-out, pipeline, and join runs.
  Workflow Script is an opt-in integration in the Tools dashboard and CLI
  `/tools`; disabling it applies to every agent.
- **Workflow scripts can start from selected files** — launch files are
  separated into editable inputs, read-only context, and media, then exposed
  to the script as immutable launch context for its workflow-agent calls.
- **Workflow scripts can route each task to a suitable model** — individual
  calls may select an available model, allowing routine work to use a cheaper
  model while difficult steps retain a stronger one.

#### Bug Fixes

- **Kimi Code usage is recorded as subscription usage** — membership-backed
  requests now appear with the other subscription usage instead of personal
  API-key usage.
- **Parallel agents resume reliably after model connection failures** —
  concurrent runs recover without overwhelming the provider, while unattended
  approved retries continue until success or cancellation.
- **Brief network interruptions no longer stop model turns immediately** —
  requests retry automatically when a provider connection drops unexpectedly.
- **Expired OpenAI connections no longer crash long-running sessions** — when
  a connection expires between turns, the next turn reconnects instead of
  terminating TeXRA.
- **Parallel runs finish reliably after long pauses** — several agents can save
  their final results without TeXRA exiting early.
- **PDF attachments work with ChatGPT subscriptions** — documents can be sent
  directly to supported models.
- **Parent agents can inspect generated workflow files directly** — delegated
  workflows make every output available for follow-up review.
- **Nested orchestrators respect delegated-task auto-approval** — enabling
  automatic delegation on a parent now lets its suborchestrators continue
  delegating without additional permission prompts.
- **Starting a subagent no longer changes the active view** — new and resumed
  child runs stay in the background until selected.
- **Personal-key and subscription sessions avoid unnecessary reconnects** —
  model connections no longer rebuild repeatedly because an unrelated
  included-access sign-in is nearing renewal.
- **Latexdiff files with short commit hashes stay protected** — generated
  comparisons with 4-5-character hashes are recognized correctly during
  editing, cleanup, packaging, and follow-up runs.

### Extension (VS Code) and Desktop

#### New Features

- **Preset teams can run from the main launcher** — interactive sessions can
  switch between an individual agent and a team, choose a preset, and handle
  unavailable members before launch.
- **Codex runs show per-turn progress** — the progress view displays the thread
  ID, live turn status, elapsed time, and failures.
- **Workflow scripts can show their complete task plan** — declared tasks
  appear before execution and update in place as they run, finish, fail, or
  are skipped.

#### Bug Fixes

- **Completed background tasks leave the session list** — finished shell tasks
  are removed after their results are saved instead of leaving stale tabs.
- **Workflow-script sessions show their own identity** — scripted orchestration
  runs display the script name and type instead of appearing as the default
  worker agent.

### Extension (VS Code)

#### Bug Fixes

- **Display equations render next to surrounding text** — bracketed and
  dollar-delimited display mathematics no longer require blank lines before or
  after the equation in agent responses.
- **Kimi K3 stays easy to find when its route changes** — the model remains
  under Moonshot while showing whether requests use Moonshot, Kimi Code, or
  OpenRouter.

### CLI

#### New Features

- **Overleaf projects can be cloned from the terminal** — `texra clone`
  accepts an Overleaf or ShareLaTeX project URL or project ID, securely stores
  the Git token, and can create an optional destination directory.
- **Context compaction is visible while it runs** — the terminal status bar
  shows a compacting indicator while conversation history is being summarized.
- **Kimi Code subscription joins model access** — the launcher and `/api` now
  offer Kimi Code alongside ChatGPT subscription, included TeXRA access, and
  personal API keys. Selecting it routes Kimi models through your Kimi Code
  membership while other models use the independently selected included or
  personal fallback. ChatGPT and Kimi Code preferences can both be enabled,
  and status views report each preference separately from the API fallback.
- **API keys and provider routing can be managed from `/config`** — masked key
  status and secure entry are available for every provider, with Kimi Code,
  provider region, and GLM Coding Plan preferences under "Models and providers".
- **Nested subagents remain visible** — a focused subagent reports how many
  direct subagents it owns, including completed work that remains available in
  its child list.
- **Focused workflow agents show concise live activity** — selecting a workflow
  child shows input and context counts, phase changes, tool calls, and errors
  without filling the conversation with raw model prose.

#### Bug Fixes

- **Kimi Code access is labeled as a subscription** — model pickers and
  running-session status no longer describe Kimi Code membership usage as
  personal API-key access.
- **Model failures show their reason** — failed model requests now include a
  concise provider message and are no longer labeled as tool failures.
- **Large multi-agent runs use substantially less memory** — inactive subagent
  transcripts remain available without accumulating in the CLI.
- **Escape stops only the focused agent** — other running agents continue, and
  navigation returns to the owning session after a subagent is stopped.
- **Background shell rows no longer claim a model** — Bash sessions omit the
  parent agent's model while agents actually named `bash` still show theirs.
- **API-key retries use the current saved key** — retrying after a relay or
  subscription limit rechecks the selected provider key before switching. If
  no key is available, the CLI directs you to `/key`. If a replacement client
  cannot be prepared, the CLI restores the previous settings and reports any
  setting whose persistence cannot be confirmed.
- **Retry prompts keep their transcript available** — switching away from an
  agent waiting for a retry no longer causes the CLI to exit when that agent
  writes its next update.

### Desktop

#### New Features

- **Window titles show session activity** — desktop windows indicate when
  agents are running or waiting for approval, including after a macOS reopen.

## [0.39.7] - 2026-07-20

### Shared (all surfaces)

#### Breaking Changes

- **Crossref DOI lookups moved to `crossref_search`** — use its `doi` command
  and update custom agents that still list the temporary `crossref_doi` alias.
- **Custom agents should replace `apply_path`** — use `edit_file` and
  `write_file`; existing configurations still load but lose patch support.

#### New Features

- **Lean proofs reuse successful patterns** — Lean agents can build on proof
  techniques that worked in earlier sessions.
- **Custom agents can return validated data** — require a structured JSON
  result from an agent or workflow step.

#### Bug Fixes

- **Parallel tools keep generated files available** — all generated attachments
  are returned to the agent after parallel calls.
- **Delegated approval shows its full scope** — prompts now state that approval
  covers current and later tasks, edits, and commands in the run.
- **Invalid saved goals no longer disrupt Settings** — TeXRA reports the error,
  preserves the goal data, and loads the remaining settings.
- **Agent reviews report unreadable untracked files** — reviews now fail clearly
  instead of silently producing incomplete findings.
- **File searches report unreadable matches** — inaccessible matching files no
  longer appear as ordinary results.
- **Accepted workflow files remain editable** — agents can continue editing
  accepted output without interruption.
- **Accepting LaTeX edits removes only obsolete comparisons** — old `_diff`
  files for the replaced original are removed without affecting other files.
- **Between-round LaTeX comparisons work for current runs** — comparisons now
  work for both saved runs and active agent sessions.
- **Failed progress clearing preserves the run** — progress remains intact when
  an active session cannot be stopped.
- **Retried workflow agents show as running** — retrying one step updates its
  visible status correctly.

### CLI

#### Breaking Changes

- **Model access now uses `/api`** — use `/api chatgpt`, `/api included`, or
  `/api personal`; `/subscription` and `/sub` have been removed.

#### New Features

- **Cancel sign-in immediately** — press Esc or Ctrl-C in an account form to
  stop browser or device-code sign-in.
- **Use arrow keys to move between chat and subagents** — Up and Down move to
  the subagent list when input history ends, while Tab still works both ways.
- **Account forms keep chat history clean** — sign-in, sign-out, and access
  progress updates in place, leaving only the final result in the conversation.
- **Reference commands open outside chat history** — `/help`, `/goal` help, and
  memory views use a temporary pane or searchable scrollback for long output.
- **Manage model access and accounts separately** — `/api` chooses ChatGPT,
  included, or personal access; `/auth` shows sessions and routing; `/logout`
  signs out of one or both accounts.
- **Skip or retry one workflow agent** — restart or bypass an individual step
  without restarting the full workflow.
- **Terminal titles show run status** — supported terminals show when a project
  is running or awaiting approval, then restore the idle title.
- **Focused workflows show more detail** — each phase lists agent models,
  elapsed time, tool calls, token use, and cost.

#### Bug Fixes

- **Generated-file history reports inaccessible files** — unreadable artifacts
  now produce an error instead of appearing as empty files.
- **ChatGPT limits no longer switch credentials silently** — the CLI shows the
  limit and reset time before offering to retry with a personal OpenAI key.
- **Edit previews open at the first change** — long context no longer hides the
  proposed edit below the fold.
- **Run activity stays visible throughout a turn** — the elapsed-time indicator
  remains animated for all active agent work.

### Extension (VS Code)

#### New Features

- **Workflow phases show their plan position** — headers display the current and
  total phase number.

#### Bug Fixes

- **Moonshot key links match the selected region** — key actions open the China
  or international console for the configured endpoint.

### Desktop

#### Bug Fixes

- **Packaged Desktop starts successfully** — the app can save its startup state
  without failing on the state file.

## [0.39.6] - 2026-07-18

### Shared (all surfaces)

#### New Features

- **Kimi Code membership models** — use a Kimi Code key for both coding models,
  and optionally route Kimi K3 through Kimi Code without a duplicate picker entry.
- **Conversation history is shared across TeXRA apps** — project sessions from
  the CLI, Desktop, and VS Code extension appear in the same history.
- **Kimi K3** — Moonshot's flagship model with a 1M-token context window,
  vision, and always-on reasoning joins the default model list.
- **GPT-5.6 Pro** — OpenAI's pro reasoning mode is available through direct API
  access for demanding tasks where latency is less important.
- **Custom agents can run resumable multi-agent workflows** — scripted
  workflows keep completed steps after interruptions and show session progress.

#### Bug Fixes

- **Credential setup stays private and app-specific** — setup distinguishes all
  access methods and collects API keys through the current app's protected input.
- **Relay failures support private diagnostics** — support can trace failures
  without recording request content.
- **Active sessions are protected across TeXRA apps** — clearing history or
  progress in one app no longer removes or fails a run active in another.
- **Saved app logs redact provider credentials** — credentials are removed from
  saved extension and app logs without changing local CLI output.
- **Tool setup notices appear in every relevant session** — one active session
  no longer hides dependency guidance from another.
- **Subagent follow-ups arrive exactly once** — messages reach waiting and
  resumed subagents without being delayed, repeated, or falsely marked failed.
- **Auto-approval stays synchronized across agents** — CLI approval persists
  across turns, and parent changes reach delegated agents immediately.
- **Resumable workflows are easier to fix** — clearer file guidance and failure
  details help agents reject missing inputs and preserve completed steps on retry.

### CLI

#### New Features

- **Add provider keys from CLI chat** — `/key` opens masked key entry and
  switches to personal API access after saving.
- **Subagent rows show elapsed time and generated tokens** — see each child's
  progress at a glance, with a compact layout in narrow terminals.
- **Todo panels are easier to distinguish** — a blank row separates the
  todo or plan checklist from adjacent content.
- **Subagent rows show their latest message** — each row previews the latest
  response, or the current instruction while running.
- **Workflow rows show each agent's round** — session rows and the status bar
  display progress such as `r2/3` without requiring focus.
- **Waiting agents show what they need** — rows display the request type and
  queue count, and selecting one brings its request forward.
- **Workflow progress remains in scrollback** — delegated phases, log messages,
  and step costs stay beneath the workflow call.
- **Full tool output stays in scrollback** — press Ctrl-T for the focused
  session or `v` on a selected child to print searchable output.
- **Navigate all child work from one list** — Tab selects sessions and processes,
  Enter opens them, finished entries remain available, and completed children
  return focus to their parent.

#### Bug Fixes

- **Clipped tool output keeps its status** — shortened rows retain their preview,
  error styling, and state cues.
- **CLI hints no longer appear twice** — shortcuts stay in the status bar and
  `/help`, while queued follow-ups stay in their own panel.
- **Long approval plans are scrollable** — use arrow keys or PgUp and PgDn to
  review the full plan before approving it.
- **Chat messages stay visually separated** — a blank line now follows every
  user message.
- **Ctrl+C clears dialog text first** — press it once to clear typed text and
  again to stop the response or exit.
- **Slash-command pickers work consistently in small terminals** — lists share
  compact navigation, and shortcuts typed while loading apply when ready.

### Extension (VS Code)

#### New Features

- **Moonshot API regions** — choose the China or international endpoint in
  provider settings.
- **VS Code language models support images and tool context** — models can
  receive images and show clearer context while using TeXRA tools.

#### Bug Fixes

- **Extension history survives live-refresh failures** — reopening Settings
  refreshes history without disrupting the extension.

### Desktop

#### Bug Fixes

- **Desktop history survives live-refresh failures** — manual refresh continues
  working without closing the app.

## [0.39.5] - 2026-07-15

### Shared (all surfaces)

#### Bug Fixes

- **OpenAI-compatible streams accept response metadata** — conversations no
  longer stop when a provider sends harmless metadata during a response.
- **Stored conversation inspection retains provider-native content** — Google
  message parts and OpenAI tool calls no longer disappear from conversation
  output, and long entries remain bounded for readability.
- **Run completion storage failures are no longer hidden** — if TeXRA cannot
  save a completed or failed run safely, it reports the problem and avoids
  offering stale work as an ordinary resumable session.

### Extension (VS Code) and Desktop

#### Bug Fixes

- **Approve-all settles queued delegated work** — approving the rest of a
  delegated session now resolves its waiting tasks, file edits, and commands,
  and the menu explains the full scope before applying it.
- **Pending external inquiries restore reliably** — reopening or moving the
  progress view reloads every open inquiry and its thread before the view is
  ready, even when another request was already visible.

### Extension (VS Code)

#### New Features

- **Use GitHub Copilot models in VS Code (Experimental)** — compatible models
  from the user's existing Copilot subscription can now be selected in the
  Models tab without adding a provider API key. If Copilot usage is
  exhausted, TeXRA can retry with a saved key for the same provider.

### CLI

#### New Features

- **Configure agents and defaults from one place** — `texra config`, the
  launcher's Settings screen, and `/config` now provide the same controls for
  the available-agent roster, default team, and default chat agent. Scripts
  can use `texra config agents` without opening the interactive interface.
- **Approve all remaining delegated work at once** — press `a` to approve the
  current task and avoid further task, file-change, and command prompts for
  that delegated session.

#### Bug Fixes

- **Ctrl+C clears unfinished chat input before stopping or exiting** — pressing
  Ctrl+C with a non-empty draft now clears the draft; pressing it again keeps
  the existing response-stop or exit behavior.
- **Session navigation uses one persistent list** — `Tab` opens the vertical
  list for the main and delegated sessions; arrow keys select a session,
  `Enter` focuses it, and reopening the list restores the previous selection.
- **Nested settings lists remain responsive after going back** — returning from
  a `/config` subsection no longer leaves the parent list unable to accept
  keyboard input.
- **Retry prompts no longer ask for discarded feedback** — choosing “give up”
  now cancels immediately instead of opening a rejection note that the retry
  flow cannot use.
- **Concurrent team runs keep their own agent choices** — starting or stopping
  one team no longer changes which agents are available to another session or
  rewrites the workspace's agent settings.

## [0.39.4] - 2026-07-13

### Shared (all surfaces)

#### Breaking Changes

- **Minimum supported VS Code version raised to 1.125** — the extension's
  `engines.vscode` requirement moved from 1.106 to 1.125; users on older VS
  Code releases must update before installing this version.

#### New Features

- **Optional ChatGPT sign-in for compatible OpenAI models** — the CLI and
  extension can use supported ChatGPT subscription models as an alternative to
  configuring an OpenAI API key, with availability refreshed after sign-in.
- **Experimental Meta (Muse Spark) provider** — Muse Spark 1.1 can be tried
  with your own Meta Model API key (dev.meta.ai). The experimental integration
  supports reasoning, tool calling, vision, and PDF input through Meta's
  Responses-compatible API surface.
- **OpenAI parallel function calls are enabled by default** — supported OpenAI
  models can plan independent tool calls together, while TeXRA continues to
  preserve ordering for edits and other side-effectful actions.
- **Free relay accounts can run four requests concurrently** — the free-tier
  concurrency allowance has doubled from two while existing rate and spending
  limits remain unchanged.

#### Bug Fixes

- **Corrupt local state is preserved for recovery** — malformed CLI and desktop
  state, settings, credentials, and stream snapshots now fail visibly instead
  of being treated as empty data and overwritten by the next update.
- **Incomplete teams are decided before roster changes** — TeXRA now offers
  sign-in, explicit partial-team continuation, or cancellation before applying
  or launching a team whose TeXRA-hosted members are unavailable.
- **Grok models keep a medium reasoning-effort selection** — the xAI effort
  clamp no longer converts `medium` to `high`; current Grok reasoning models
  (grok-4.3, grok-4.5) support low/medium/high.
- **ChatGPT subscription compaction keeps streamed summaries** — when the
  subscription backend leaves the completed response body empty, TeXRA now
  rebuilds the summary from streamed text so long conversations still compact.
- **OpenAI context checks use the final request size and current model limits**
  — GPT-5.6 requests now use the correct input and output allowances, and an
  overflow that provider compaction cannot recover is surfaced without futile
  automatic retries.
- **Usage accounting preserves unsettled relay batches** — transient failures
  and partial acknowledgements retain the same batch for retry, while permanent
  rejection is reported instead of being treated as successful delivery.
- **Agent runs no longer start with unavailable transcript persistence** —
  headless CLI, desktop, and extension execution now fail initialization when
  persistent transcripts cannot be opened. Interactive CLI fallback sessions
  are clearly marked as ephemeral and are not advertised as resumable.
- **Resumed sessions restore their visible outputs** — workflow outputs,
  missing-output notices, and compile-failure details are replayed after
  hydration instead of disappearing from the resumed conversation.
- **Approvals remain tied to the current session and proposal** — stale or
  unreadable diff fallbacks cannot be approved, and concurrent sessions no
  longer share pending approval state.
- **YOLO approval carries across parallel tool calls** — approving the first
  command or file edit for a stream now lets the remaining queued calls observe
  that decision instead of prompting one by one.
- **Background work reconnects more reliably** — waiting parents wake when a
  background shell task finishes, and Claude-agent sessions can recover their
  resume state from disk after a reload or crash.
- **Anthropic web-fetch results retain source details** — fetched titles, URLs,
  and page content remain available to the agent instead of being flattened
  into an incomplete result.

### Extension (VS Code)

#### New Features

- **Team application offers Researcher Access when remote members are missing**
  — applying a team while signed out now offers sign-in, reloads remote agents
  after authentication, and reapplies the complete roster.

#### Bug Fixes

- **Lean project commands wait for the Lean extension to become ready** — cache
  fetching and other project actions no longer fail with a missing-command
  error while the Lean client is still activating.
- **Progress entries keep disclosure controls on the left** — assistant,
  thinking, tool, and file entries use Web Awesome's native left-side
  disclosure placement consistently.
- **Agent Review stops cleanly from its owning execution** — stopping a review
  now releases its in-progress state instead of leaving later reviews blocked.
- **Pasted images stay with the conversation that accepted them** — switching
  streams while an image is being prepared no longer delivers it to the wrong
  follow-up input.
- **AI-agent settings reflect current routing and models** — Claude Code now
  defaults to Sonnet 5, and the ChatGPT tool-use-only option no longer cites an
  outdated Codex background-mode limitation.

### Desktop

#### Bug Fixes

- **Running sessions stay connected after reopening the desktop window** —
  active runs, later turns, subagents, status updates, and pending interactions
  are rebound to the replacement window instead of continuing without visible
  progress or controls.
- **Desktop update checks follow the window lifecycle** — checks are serialized
  so closing or replacing a window cannot leave overlapping update requests or
  stale notifications behind.
- **Approvals survive window replacement** — closing and reopening the desktop
  window no longer rejects or loses an approval requested by a session that is
  still running.

### CLI

#### New Features

- **Model access can be changed from the startup launcher** — choose a ChatGPT
  subscription, included TeXRA access, or personal API keys before starting a
  session.
- **Startup and settings lists are easier to scan** — resumable sessions,
  agents, and teams now live behind one entry each; the launcher also provides
  account sign-in and sign-out controls. `/config` groups settings by subject.

#### Bug Fixes

- **Interrupted chats retain context and queued follow-ups** — pressing Escape
  during an active response preserves the resumable conversation; messages
  submitted during teardown or a failed restore remain in order for the next
  retry instead of being silently dropped.
- **Model access choices apply to the launched session** — switching access at
  startup overrides an earlier command-line mode, and selecting ChatGPT turns
  off OpenRouter routing so requests use the chosen subscription.
- **Terminal status stays readable during long sessions** — history omits
  internal process bookkeeping, completed transcripts repaint after resizing,
  and the Ctrl-C hint follows whether a run is actually active.

## [0.39.3] - 2026-07-10

### Shared (all surfaces)

#### Bug Fixes

- **TikZ extraction handles wide and unlabeled figures correctly** — `figure*`
  environments are now detected, and an unlabeled figure can no longer borrow a
  later figure's label.
- **Background result delivery handles generated ids safely** — subagent
  background-command results are now escaped before being sent back to the
  orchestrator, so ids containing XML-sensitive characters no longer corrupt
  the delivered result.
- **More provider API keys are redacted from logs** — desktop and other
  redacting log sinks now cover the key formats used by all configurable model
  providers, including Google auth keys.
- **Setup no longer reports expired or revoked relay tokens as signed in** —
  authentication status now verifies configured CI relay tokens while still
  preserving valid Supabase sessions and direct API-key-only setup.
- **Workflow LaTeX compilation resolves source directories consistently** —
  compile checks and latexdiff PDF builds now share one workspace-source
  resolver, and a real workspace folder named `r1`, `r2`, and so on is no
  longer mistaken for a run-storage round folder.
- **OpenRouter transient server errors no longer stall a request for up to an
  hour** — the OpenRouter SDK's built-in retry window is now capped at 30
  seconds, so a persistent 5XX surfaces through TeXRA's visible retry/failure
  path instead of backing off invisibly inside a single attempt.
- **Retry-attempt defaults are now consistent across hosts** — with
  `texra.model.retry.maxAttempts` unset, CLI and desktop runs previously fell
  back to 1 flow-managed retry while VS Code used the documented default of
  0; all hosts now use the documented default. Set the option explicitly to
  restore extra automatic retries.
- **Web search/fetch links now block dangerous URL schemes** — a link
  surfaced from a web search result or fetched page can no longer use a
  `javascript:`/`data:`/`vbscript:`/`file:` URL to become a live,
  script-executing link; only `http:`, `https:`, and `mailto:` links render
  as clickable, in both the Progress View and exported HTML chats.
- **ChatGPT-subscription (Codex) models now compact long conversations** —
  this backend requires `store: false`, so OpenAI's stateful compaction
  endpoint never had a stored response to act on and long runs just grew
  until they hit the context ceiling. Both the automatic threshold-based
  compaction and the manual "compact now" action now summarize the
  conversation locally and resend a shorter history instead.
- **Anthropic and Google tool-use sessions keep agent instructions consistent
  across turns** — persona, tool-use instructions, and delegation policy are
  now resupplied on every model call, matching the continuity already provided
  by providers that carry those instructions in message history.

#### Improvements

- **Updated model catalog** — `llm-zoo` 1.14 adds the GPT-5.6 model family,
  which now fills the default OpenAI picks in the model list in place of the
  deprecated GPT-5.4; ChatGPT-subscription sign-in and long-conversation
  compaction continue using GPT-5.5, the generation Codex still serves.
- **Read-only tool calls in one model response now run in parallel** —
  contiguous batches of side-effect-free tools (file reads, grep/glob, web
  fetch/search, arXiv/Crossref/Zotero/Loogle lookups, texcount) execute
  concurrently, while editing tools keep their strict order. Interrupting a
  run now also cancels in-flight web fetches/searches, Loogle and Zotero
  requests, grep subprocesses, and glob walks immediately; arXiv/Crossref
  lookups stop at their next cancellation point (their client libraries are
  not mid-request abortable).
- **Duplicate parallel tool calls no longer waste a model turn** — identical
  calls in one batch (including accidental GPT re-emissions of bash/write)
  execute once and share that result with the duplicates, so the model does
  not see skip errors or re-run the same side effect.
- **Faster subagent result delivery** — the orchestrator wakes as soon as a
  subagent finishes instead of waiting for report persistence, and
  consecutive maintenance follow-ups batch into a single turn.
- **`settings.documentTag`/`endTag` are no longer configurable in custom
  agents** — every agent now emits the standard unified output container,
  matching what every bundled agent already used. These fields no longer
  affect custom agent behavior.
- **Subagent runs record a structured result manifest** — outputs, line-diff
  references, outcome, and cost are readable as JSON via the executions tool
  (`/executions/{id}/result`), so follow-on agents can chain on data instead
  of parsing prose.

### Extension (VS Code) and Desktop

#### Bug Fixes

- **Provider API keys are saved without surrounding spaces** — keys entered or
  pasted with accidental whitespace are normalized before storage.

### Extension (VS Code)

#### Bug Fixes

- **Bundled skills are available in installed extensions** — VSIX packages now
  include the built-in skill definitions, so enabling runtime skills exposes
  the same bundled catalog in installed extensions as in development.

### CLI

#### Bug Fixes

- **Ctrl-C reliably cancels queued-follow-up auto-resume** — stopping while an
  automatic resume is still loading configuration or session data no longer
  allows that stale preparation to restart the cancelled stream.
- **NDJSON records preserve their emission order under stdout backpressure** —
  progress, command results, doctor output, and structured error/instruction
  records now share one queued stdout writer.
- **Shell-backed tool approvals use command-neutral wording** — Wolfram and
  other command-backed tools no longer appear as Bash actions in the prompt,
  session shortcut, status details, headless summary, or rejection message.

### Desktop

#### Bug Fixes

- **Desktop asks before deleting provider API keys** — removing a stored model
  provider key now uses the same confirmation step as the VS Code extension.
- **HTML chat export works in packaged desktop builds** — desktop packaging now
  includes the standalone trace-viewer template used to create self-contained
  HTML exports.

#### Improvements

- **Runtime skills are available in desktop agent runs** — desktop now loads
  project, user, and bundled skills through the same shared Node-host defaults
  as the CLI.

## [0.39.2] - 2026-07-03

### Shared (all surfaces)

#### Improvements

- **Agent output recovery is more forgiving** — multi-file workflow output can
  now be recovered even when the model omits the expected XML or percent-header
  filename markers, as long as the generated sections can still be matched
  safely.
- **Provider API keys can be supplied through familiar environment variables** —
  provider-style variables such as `ANTHROPIC_API_KEY` are now recognized by the
  same paths that read stored keys.

#### Bug Fixes

- **OpenAI streaming falls back when the SDK sees a new event type** — if the
  OpenAI SDK throws on an unrecognized response-stream event, TeXRA falls back
  to polling instead of failing the run.
- **Anthropic stream failures are labelled more accurately** — failures after
  `message_start` are no longer misreported as pre-message-start failures.
- **The text editor tool preserves dollar signs** — `str_replace` edits no
  longer corrupt replacement text containing `$` sequences.
- **Model and stream failures get clearer annotations** — stream failures,
  retry handoffs, and API-key status labels now report the relevant state more
  directly.

### Extension (VS Code) and Desktop

#### Bug Fixes

- **The launcher selects team root agents correctly** — choosing a multi-agent
  team now selects its orchestrating/root agent in the run launcher instead of
  leaving the previous agent selected.
- **Desktop repairs orphaned streams on startup** — after a restart, desktop
  streams that were left running or waiting are reconciled instead of staying in
  a stale in-flight state.

### Extension (VS Code)

#### Improvements

- **The GitHub integration accepts CLI-style token variables** — the GitHub
  subscription tool now recognizes the token environment aliases users commonly
  configure for command-line GitHub tools.

### CLI

#### Improvements

- **Tool integrations appear in the config catalogue** — CLI configuration now
  exposes tool-integration settings alongside the other shared settings.

#### Bug Fixes

- **Headless run history is more complete** — non-interactive CLI runs now keep
  the durable progress metadata expected by resume and history tools.
- **API access labels are clearer** — model availability output distinguishes
  relay, subscription, and local-key states more plainly.

## [0.39.1] - 2026-06-30

### Shared (all surfaces)

#### Improvements

- **Claude Sonnet 5 support**
- **Gemini now uses Google's Interactions API by default**
- **ChatGPT subscription: tool-use-only scope and a context cap**
- **latexFixer repairs more bibliography and hyperlink failures**
- **The `ls` tool is gone**

#### Bug Fixes

- **latexFixer no longer overwrites your workspace files with generated output**
- **Retired models are clearly marked unavailable**
- **Clearer message for models from keyless providers**
- **Workflow compile and LaTeX diff resolve inputs in subfolders**
- **Workflow outputs are recovered from percent filename headers**
- **Streaming output no longer hangs or gets double-cleaned on errors**

### Extension (VS Code) and Desktop

#### Improvements

- **The "fix LaTeX" actions run on the helper model**
- **Sign in with ChatGPT from a non-default browser**
- **First-run setup no longer launches itself**
- **The usage panel shows how each run is billed**
- **One place to manage provider keys in Settings**
- **Consistent tooltips on icon-only buttons**

#### Bug Fixes

- **No stray whitespace in terminal output**

### Extension (VS Code)

#### Features

- **Agents can leave inline comment threads**

#### Improvements

- **The setup assistant can audit your stored API keys**

### CLI

#### Improvements

- **The terminal starts with every agent enabled, not a single discipline**
- **`assistant` is the default chat agent**
- **Switch teams from the launcher**
- **The launcher header shows the CLI version**
- **One command to inspect a team**
- **The CLI auto-switches to your saved API key on a usage limit**
- **Clearer `texra init` guidance when your model isn't usable**
- **Clearer session-wide approval labels**
- **`/config` exposes more settings**
- **`/config` validates as you edit**
- **No redundant "add a provider key" hint**

#### Bug Fixes

- **Memory and goal tools now reach CLI agents**
- **History list shows chat descriptions**
- **Headless multi-agent runs reject the "ask" approval policy**
- **More CLI commands honor `--output-format`**
- **Unsupported Copilot models are hidden from the CLI**
- **Finished replies no longer print twice**
- **No stray rows after display-math replies**

## [0.39.0] - 2026-06-28

### Shared (all surfaces)

#### Improvements

- **Switch from your ChatGPT subscription to an API key when the quota runs out** — when a Codex model driven through your ChatGPT subscription hits its plan usage limit, the error now says so clearly (plan and how long until it resets) and offers a one-click switch to your own OpenAI API key. Accepting turns off "prefer ChatGPT subscription" and retries the same request on your key. In the VS Code progress view press **Use your own API key** (or `k`); in the CLI press `k` on the retry prompt or run `/subscription off`. Auto-retry no longer hammers an exhausted subscription.
- **Clearer validation error messages** — when a configuration value, stored session, or API response fails schema validation, the error now reads as a concise human-readable summary of what was wrong instead of a raw JSON dump of the validation internals.

#### Bug Fixes

- **Delegation launches the agent it validated** — when a custom or remote agent shares a name with a built-in agent of the other type (e.g. a custom workflow `assistant` next to the built-in tool-use `assistant`), delegating no longer resolves a different agent at launch than the one shown and validated, which previously failed with a spurious "is a workflow agent but was launched as tool-use" error. The agent's identity is now resolved once when the delegation is validated and carried through to launch, so the same agent runs even when you swap the agent during approval.
- **Unavailable model overrides fail fast** — approving a delegation after switching the model to one that isn't available in the active API mode now reports it immediately, instead of reporting the subagent as launched and then failing asynchronously. The approve path uses the same availability check as the initial delegation.
- **Windows: cancelling or timing out a shell command now stops its child processes** — when a `bash`-tool command was stopped or hit its timeout on Windows, only the top-level shell was terminated and any piped or background child processes (e.g. `find | head`) were left running. They are now torn down with the rest of the command tree.
- **ChatGPT subscription: no more HTTP 400, and the WebSocket transport works** — running a Codex model through your ChatGPT subscription failed with `HTTP 400 Bad Request` whenever the background-responses toggle was on, and the experimental OpenAI WebSocket transport returned nothing (empty output, dropped tool calls). The Codex backend has no background mode and signals completion with an empty body, so background mode is now skipped for it and the WebSocket path rebuilds the response from the streamed items. Workflow and tool-use agents now run end-to-end over WebSocket on the subscription, and a keepalive holds the connection open through long reasoning — the steadier transport when a model thinks for a long time (the subscription always talks to ChatGPT directly, never through the relay). Headless runs also exit cleanly instead of lingering on an open socket.
- **"Use your own API key" no longer re-prompts when a key is already saved** — accepting the switch after a relay or ChatGPT-subscription usage limit now reuses your stored OpenAI key and retries immediately, instead of popping the key-input prompt for a key you already have. It only asks when no usable key exists; the case where the stored key itself is the exhausted credential still asks for a new one.
- **Google (Gemini) completions are no longer discarded as cancellations** — a Google Interactions run that finished normally could be misread as a user cancellation, throwing away the output it had already produced. Its terminal status is now mapped to the canonical finish reason, so completed and truncated Google runs are finalized the same way as the other providers.
- **A run that produces no extractable files now warns instead of silently "completing"** — when the model returns output that cannot be split into the expected files (e.g. it did not wrap each document in the required tags), TeXRA surfaces a warning that points at the kept raw output, rather than finishing as if it succeeded while writing nothing.

### CLI

#### Features

- **`/config` settings panel** — view and change settings from the chat TUI without leaving the terminal. `/config` (alias `/settings`) lists each setting with its current value and where it is stored; press Enter to toggle a switch, pick from a choice list, or edit a value inline. Covers the git commit-author identity (applied to agent commits and worktrees) and the workflow auto-compile options the CLI uses for `texra workflow` / `texra run`. Settings come from the same shared catalog the VS Code extension uses, so the two surfaces stay in sync instead of drifting apart.
- **`texra latexdiff` command** — generate round-aware LaTeX diffs for an agent run's outputs straight from the terminal, the same capability the VS Code extension offers. Point it at a run with `texra latexdiff <agent> -m <model> -i <file>`; add `--between-rounds` to also diff consecutive rounds, `--run-id` to target a specific execution, and `--output-format json|ndjson` for scripting.

#### Improvements

- **Leaner, non-overlapping CLI options** — trimmed redundant choices so the same thing has one spelling: `--api-mode` now accepts just `included`/`personal` (plus the `relay`/`byok` shorthands) instead of seven near-synonyms, the duplicate `texra agents inspect` is gone in favor of `texra agents show`, and `texra login` now rejects `--device` together with `--no-browser` (they are different sign-in transports) instead of silently ignoring one.
- **`--websocket` / `--no-websocket` flag** — turn the experimental OpenAI WebSocket transport on or off for a single run (`texra run … --websocket`, `texra chat --no-websocket`, etc.) instead of only through the stored setting; omit it to use your saved preference. The negated form is also recognized for routing and shell completion.
- **External Inquiry is now VS Code / desktop only** — the human-in-the-loop "ask an external chat subscription" tool relies on the long-lived progress-view panel for pasting answers back, which the terminal does not provide, so it is hidden from every CLI run (interactive chat and headless commands alike) and no longer listed under `texra tools`. Agents running in the CLI will not attempt to dispatch external inquiries.

### Extension (VS Code)

#### Features

- **TeXRA research tools in Copilot Chat** — when running on a VS Code build that supports the Language Model Tool API, TeXRA's arXiv search, web fetch, and Crossref search are available in Copilot Chat as `#texra_arxiv_search`, `#texra_web_fetch`, and `#texra_crossref_search`, so agents can pull papers, web pages, and citations without leaving chat. Hosts without the API simply don't show them.
- **Live usage in the status bar** — hovering the TeXRA status bar item now shows a running cost and input/output token total for active streams, so you can keep an eye on spend without opening the task board.

#### Improvements

- **Clearer pickers** — file, credential, review, and tool-selection menus now keep an explanatory hint visible as you type (on VS Code 1.108+): the latexdiff math-markup and review pickers show your saved default, the API-key picker reminds you keys are stored encrypted, the "Accept edits" picker keeps the edited filename in view, and the review flow echoes your focus text. Entering an API key offers a one-click "Get API key" button inline (VS Code 1.109+).
- **"Yolo (this session)" right on the approval prompt** — edit and bash approval prompts now offer a **Yolo (this session)** option under the Approve button's ▾ menu (keyboard shortcut `a`), mirroring the CLI's "approve session". It approves the current action and turns off approval prompts for edits and bash commands for the rest of that stream — the same effect as the toolbar shield, but discoverable at the moment you're asked. Previously the only way to enable auto-approval was the shield icon in the progress-view toolbar, which first-time users could easily miss.

#### Bug Fixes

- **Tool-edit approval no longer hangs when you close the diff** — closing the proposed-edit diff tab now rejects the edit instead of leaving the agent waiting indefinitely.
- **More precise diff cleanup** — finishing a tool-edit approval now only closes that exact diff, never an unrelated diff that happens to share a file.

## [0.38.10] - 2026-06-23

### Shared (all surfaces)

#### Features

- **Experimental: use your own ChatGPT subscription for Codex models** — sign in with your ChatGPT Plus/Pro/Team account and route Codex models through your subscription instead of a separate API key. In the CLI, sign in with `texra auth chatgpt login` and toggle it with `/subscription on|off` (alias `/sub`); in the VS Code extension, sign in from Settings → Models. Turn it on with the "chatgptCodex.preferSubscription" setting. The login opens your browser or, on a headless shell, shows a one-time device code; check or end the session with `texra auth chatgpt status` and `logout`. Off by default and clearly marked experimental and personal-use: it relies on an unofficial OpenAI endpoint that can change or stop working without notice, and it only ever uses your own signed-in session.
- **Workflow round counts** — workflow progress now reports how many rounds are planned, so you can see how far a multi-round run has to go.

#### Improvements

- **More reliable Lean theorem search** — Loogle queries now retry automatically when the server times out, drops the connection, or returns a transient server error, so a brief hiccup no longer surfaces as a failed search; genuine bad requests still fail fast.
- **Proofreading preserves math style** — the Correct agent now keeps your existing math formatting intact while fixing the surrounding prose.

#### Bug Fixes

- **Cleaner history previews** — provider "thinking" / reasoning text no longer leaks into the previews shown when browsing past conversations.
- **OpenRouter setup mismatch** — when a configured model isn't available on OpenRouter, setup now surfaces the mismatch before prompting for credentials instead of after.

#### Features

- **Use Google's Interactions API for Gemini** — TeXRA can now talk to Gemini models through Google's newer Interactions API instead of Generate Content. Turn it on with the `model.useGoogleInteractionsAPI` setting (off by default; Generate Content stays the default and fallback). When enabled, conversation state is kept on Google's servers by default so each turn sends only the new message (smaller, faster requests) — Google retains the conversation for a limited period to make this work. To keep conversations off Google's servers and resend the full transcript each turn instead, turn off `model.useGoogleInteractionsServerState`.

### CLI

#### Improvements

- **Smoother terminal redraws** — the chat TUI now repaints atomically (synchronized output) when you resize the window or switch between the main transcript and a focused sub-agent, so resizing and view switches no longer flicker or leave stray fragments on terminals that support it.

#### Bug Fixes

- **Discoverable hidden models and agents** — hidden CLI models, launchable agents, and JSON agent listings now surface their entries (with hints) instead of appearing empty, and shell completion offers the right agents and `--model` values for zsh.
- **Tidier agent and child pickers** — the agent picker and child-stream picker now keep their labels, rows, and copy within the frame instead of overflowing in narrow terminals.
- **Multi-agent launcher polish** — clearer launcher hint, completions scoped to the launch category, zero-count categories omitted, and a more stable multi-agent run validator.
- **Correct workflow output handling** — workflows write nested output paths and directories correctly, use stable filenames for stdin input, persist copied outputs in history, and preserve file lineage when inputs share a basename.
- **Better history defaults** — `texra history` with no subcommand now lists your history, and history details show the team identity and the workflow's output files; runs hidden because they belong to another working directory now explain why instead of silently vanishing.
- **Friendlier errors and hints** — unknown commands are rejected before help is shown, model names are normalized, model-recovery hints appear when a model is unavailable, rejected interactive flags are reported precisely, and the personal-API status label is clearer.
- **Smaller transcript and approval fixes** — the inquiry tool's raw syntax is hidden in the transcript, edit-approval hunk counts are pluralized correctly, quiet-agent visibility notices are suppressed, and the active-response follow-up tip is shown.
- **Correct status and credentials** — the `/status` view shows the right working directory, CLI credentials are stored under your configured storage root (so a custom storage location keeps its own sign-in), and an invalid workflow input is reported clearly instead of surfacing as an unrelated model error.
- **`agents inspect` alias** — `texra agents inspect` is now accepted as an alias.
- **Local software-engineer team** — the built-in software-engineer team now completes correctly when run locally.

### Desktop

#### Features

- **Real onboarding state** — the desktop app now derives its onboarding funnel state from your actual credentials and setup instead of always reporting "done".

#### Bug Fixes

- **More secure, more reliable sign-in** — desktop OAuth callbacks are bound to a per-attempt nonce and the auth-bridge deep link is locked to the TeXRA publisher, and sign-in is relayed through an https bridge so Linux/Firefox can complete the flow.
- **No stale display after close** — a disposed desktop window no longer briefly shows restored content.

### Extension (VS Code)

#### Features

- **Sign in with ChatGPT in Settings → Models** — the extension adds a ChatGPT-subscription sign-in control alongside the GitHub-token status, with a matching sign-in/sign-out round-trip.
- **Improved onboarding actions** — clearer first-run onboarding with more direct setup actions.

#### Bug Fixes

- **Clearer onboarding flow** — credential onboarding is shown first, entry points are clarified, the walkthrough is aligned with credential setup, ChatGPT onboarding is prioritized, and onboarding refreshes after a setup action.
- **Stable task rows** — stopped task rows stay in place instead of jumping.

## [0.38.9] - 2026-06-18

### Shared (all surfaces)

#### Bug Fixes

- **Crash-safe run state** — run and flow progress is now written atomically, so an unexpected shutdown can no longer leave a corrupted file that makes a resumed run silently restart from scratch and lose applied edits.
- **API keys kept out of saved transcripts** — when you set a provider API key, the key is no longer written in cleartext to the on-disk run transcript or reloaded through history.
- **Contained run-file reads** — reading a file from a run's stored files now rejects paths that try to escape the run's storage directory, keeping reads contained.
- **GitHub tools work in the CLI and desktop app** — the GitHub token is now read the same way across surfaces, so GitHub commands and checks that previously did nothing outside the VS Code extension now work everywhere.
- **Safer and more correct code search** — search patterns that begin with a dash now match literally instead of being treated as options, closing a path where a crafted pattern could run a command during search.
- **Wolfram runs now ask for approval** — running Wolfram Language code through the agent now goes through the same approval prompt as other commands instead of executing without asking, and it backs off when you have asked the agent not to use external computation.
- **Reliable undo with subagents** — when a subagent and its parent edit the same file at once, undoing an edit no longer reverts the wrong run's change or writes a stale version to disk.
- **Steadier long-running sessions** — fixed a leak that kept output-decoder state for finished background processes alive until the session ended.
- **No more stalling after a tool runs** — when the model returns an empty turn right after a tool result, the agent now nudges it to keep going and deliver the answer instead of ending the turn with nothing.
- **No more doubled subagent reports** — when you wait on a subagent, its result is delivered once to the parent instead of appearing twice.
- **More forgiving shell tool** — agents can attach a short description to a command without the tool call failing; the description is ignored when running the command.
- **Cleaner Google model output** — stray control characters that Google models emit right before a tool call no longer leak into the visible response text, including when they are split across streaming chunks.
- **Cleaner command rejections** — when you decline a command an agent wants to run, it now moves on instead of repeatedly asking to run the same approval-gated command.
- **Cleaner workflow output files** — files written from multi-document workflow output now end with a single trailing newline, so generated LaTeX matches the usual file convention.
- **Proofreading stays out of the math** — the built-in Correct agent now leaves equations, theorem statements, and factual claims untouched, fixing only typos, grammar, and LaTeX formatting, so it no longer silently rewrites mathematical content.
- **Truncated text no longer breaks emoji and other characters** — one-line summaries and tool-error previews that get shortened with an ellipsis now keep emoji, CJK, and math characters whole instead of leaving a broken glyph at the cut.

#### Improvements

- **Faster Lean detection** — checking whether Lean's build tool is installed is now an instant lookup on your path instead of launching the tool, so Lean tool availability resolves faster and without a slow startup spawn.
- **Faster, less fussy reviews** — the review agent now checks elementary facts by hand instead of reaching for external computation, so reviews spend less time on trivial verifications.
- **More faithful subagent summaries** — when a coordinating agent reports back a subagent's result, it now keeps the subagent's stated evidence, tool names, and caveats accurately instead of paraphrasing or inventing different methods.
- **Delegated agents respect your limits** — when the agent hands work to a subagent, it now passes along your tool, network, file, approval, and output constraints, and the subagent reports a conflict instead of guessing when an instruction clashes with them. When you reject a delegation without a reason, the agent is told to stop retrying the same request and either continue with what it has or ask you a clarifying question.
- **No looping on plan pause or complete in chat** — in ordinary turn-by-turn chat, pausing or completing a plan now returns plain guidance and the agent answers you directly, instead of repeatedly calling the plan controls when no autonomous goal is running.

### CLI

#### Features

- **One-command code-review setup** — run `texra install-github-action` to scaffold the TeXRA code-review GitHub workflow into your repository and commit it on a branch, then push the branch and open the pull-request page so you review the diff and create the PR yourself, with graceful fallbacks when the GitHub CLI or a remote is missing.
- **Goal details in status** — the status view now shows the current goal's state and objective when a goal run is active, so you can see what the agent is working toward at a glance.

#### Bug Fixes

- **Cleaner subagent results in the chat** — long or still-streaming subagent output no longer floods your conversation log with raw protocol markup, half-written tags, or an entire dumped response. A finished subagent now shows a short, readable summary (with todo progress, turns, and current activity), a long result shows a preview with a pointer to open the full transcript, and a running subagent's live output stays within a bounded live region with full history in the transcript viewer.
- **Cleaner CLI transcripts** — HTML tags like bold, italics, code, and blockquotes that appear in model output now render as styled text in the terminal instead of showing raw markup.
- **Gemini conversations in CLI history** — browsing past conversations now shows the full transcript for Gemini-driven runs, including the assistant's replies, tool calls, and tool results, instead of leaving them blank.
- **Faster feedback on the wrong chat agent** — starting a chat with an unknown agent, a workflow agent, or a team preset now fails immediately with guidance on the right command, instead of only erroring after you send your first message.
- **Clearer configuration errors** — running an agent or workflow with an invalid setting, such as an unknown model, now shows a readable "invalid configuration" message and exits cleanly, instead of crashing with an internal error and a bug-report prompt.
- **Resume keeps your context** — the resume command the CLI prints now includes your non-default approval policy and the session's working directory when it differs from your current shell, so copy-pasting it resumes the right project with the same approval behavior instead of silently dropping to the default.
- **Piped LaTeX input** — feeding LaTeX to the CLI through stdin no longer fails when LaTeX writes its auxiliary files, because the temporary input is no longer given a hidden name that TeX could reject. These temporary files are also removed when the CLI shuts down, so interrupting a run no longer leaves stray files behind.
- **Accurate status on interrupt** — stopping the CLI mid-run with Ctrl-C now records the run as interrupted instead of leaving it in a stale or misleading state.
- **Workflow `--output` handling** — running a workflow with `--output` no longer renames the agent's working file to your copy target; the requested output file is written correctly while the workflow keeps its own filenames.
- **Stopped subagents no longer flagged as errors** — manually stopping a subagent now shows a neutral status instead of a red error dot, matching the other surfaces.
- **Focused stream tab shows when it errors or finishes** — the active stream tab now displays an error or ready status, so a focused stream that fails or completes is no longer indistinguishable from one still running.
- **Accurate context-window gauge** — the status bar now measures context-window usage from input tokens only, so the percentage and its warning colors no longer jump prematurely after a long response.
- **Cleaner machine-readable output** — the CLI no longer emits stray progress lines after a run has finished, keeping `--output-format ndjson` output well-formed.
- **Skills available in the CLI** — the terminal client now ships with its built-in skills, so they appear and run after a normal install.
- **Running a plan as a goal no longer skips edit review** — choosing **Run as Goal** now auto-approves only the plan's shell commands; file edits keep going through the normal diff approval so you still review every change.
- **Tidier model and tool pickers** — the model and tool lists now reserve room for their key hints, so the footer and bottom rows stay visible instead of being pushed off-screen in short terminals.
- **Smoother approval policy picker** — choosing an approval policy from the picker now closes the menu before applying your choice, so the new setting takes effect cleanly without the picker lingering.

#### Improvements

- **Live workflow progress** — the elapsed-time status line now keeps ticking during quiet workflow runs instead of freezing when there are no active sub-tasks, so you can tell a long run is still working. When a run processes several input files, the progress line shows the first filename with a compact "+N" so the extra inputs are no longer hidden.
- **Readable elapsed times** — the status bar and subagent timers now show compact durations like `1m 15s` and `2h 5m` instead of raw seconds.
- **Less clutter during goal runs** — the todo and plan panel now hides once every item is finished, so a stale completed checklist no longer lingers while the next turn is running.
- **Clearer plan approval** — the autonomous plan action is now called **Run as Goal**, and its prompt explains that the agent keeps working across turns until it finishes or needs input. It also states that only Bash commands are auto-approved, while edits and other actions still require review.
- **Clearer subagent panel navigation** — the Escape hint in the subagent panel now reads "back" when you are viewing a task's detail and "close" otherwise, matching what the key actually does.
- **`/goal` help** — typing `/goal` (or `\goal`) now shows a quick explanation of autonomous goal mode instead of starting an agent turn.
- **Clearer team hints** — when a multi-agent team is unavailable, the CLI now points you to `texra multi-agent inspect <team-id>` so it is obvious which value to supply.

### Desktop

#### Bug Fixes

- **Reliable PDF reopen** — quickly reopening a PDF while the previous one is still closing no longer leaves the viewer blank.
- **GitHub updates reach the right window** — GitHub subscription follow-ups now route to the session that created them, so polling updates are no longer misrouted or dropped when more than one window is open.
- **Command palette shows when nothing matches** — filtering to no results now displays "No matching commands" instead of an empty box that looked broken or still loading.

### Extension (VS Code)

#### Bug Fixes

- **Output files in remote workspaces** — when working over SSH, remote, or web workspaces, agent output files no longer split between the remote filesystem and the local disk; every chunk of a file now lands in the same place.
- **Markdown chat export** — exported conversations no longer break when tool output or fetched pages contain triple-backtick code fences; the rest of the document now renders correctly.
- **Diff view recovers from a failed load** — if the diff editor fails to load once, reopening a diff now retries instead of staying stuck on an error message for the rest of the session.
- **Unavailable models can no longer be enabled by mistake** — in Settings, models you cannot use (missing API key or not allowed) now have their checkbox properly disabled, so you cannot silently add an unusable model to your enabled set. An already-enabled model whose key was removed can still be turned off.
- **Clearer empty states** — a history search with no matches now shows a "no matches" message, and a just-started terminal-mode run shows a starting placeholder, instead of a confusing blank panel.
- **Token counts read correctly** — usage and context figures in the 100k to 1M range now show as, for example, "200k" instead of being shrunk to a nonsensical "0.2M".
- **Tidier approval buttons** — the approve, reject, and diff buttons on a tool edit request now stay inside the panel and shorten long labels with an ellipsis instead of spilling over and breaking the layout in narrow views.
- **Keyboard-activatable progress-view links** — file links, generated and proposed file links, diff results, LaTeX references, and the proposal Setup link in the progress view can now be reached with Tab and opened with Enter or Space, so keyboard-only and screen-reader users can open them, not just mouse users.
- **UI styling polish** — fixed several broken visual references: the working-directory line in approval prompts regained its spacing and muted color, desktop log and editor text use the correct monospace font, the goal panel's in-flight arrow now displays instead of a blank glyph, and the credit usage meter's colored bands render correctly again so the normal, warning, and exhausted states are visually distinct.

#### Improvements

- **Consistent icons** — progress log severities, cloud and local agent badges, and the multi-agent team marker now use the same crisp icon set as the rest of the interface instead of mixed-in emoji.
- **Cleaner screen-reader experience** — decorative icons in the main panel and toolbar are now hidden from screen readers so labeled buttons are announced once by their name, error and warning icons in the progress view carry text labels so their severity is announced, and icon-only remote and custom agent badges in settings now carry their own accessible name.

## [0.38.8] - 2026-06-14

### Shared (all surfaces)

#### Features

- **Guided first-run onboarding** — first-time users now get a setup funnel that walks through signing in, confirming model access, and seeding a starter agent team, presented consistently in the CLI and the VS Code extension.

#### Bug Fixes

- **Stopping a run kills its running command** — stopping a run now aborts the in-progress foreground `bash` command instead of leaving it (and its child processes) running in the background.
- **Killing a run honors your subagent preference** — terminating a run now also respects the "Keep agents running if I stop the orchestrator" setting, instead of always tearing down still-running subagents.
- **Subagents follow a mid-session model switch** — after you change models during a session, delegated subagents and tools now inherit your current model instead of the one the session started with.
- **Bash approvals show the working directory** — command approval prompts now display the directory the command will run in, so a relative command is no longer ambiguous about where it executes.
- **Queued follow-ups survive a failed resume** — if resuming a run fails, the follow-up messages you queued are kept and re-sent instead of being silently dropped.

#### Improvements

- **Default model is now DeepSeek V4 Pro (Thinking)** — new chats and runs default to DeepSeek V4 Pro (Thinking) instead of V4 Flash (Thinking), at the same price (~$0.14/$0.28 per MTok); the model list drops the now-redundant Flash (Thinking) entry and existing model lists reconcile automatically. Pick any other model from the Models settings tab or the `texra` model picker.
- **TeXRA is now "an AI theorist"** — the product description shown in the VS Code Marketplace, the CLI, and the welcome view is updated from "LaTeX research assistant" to "24/7 AI theorist," reflecting that TeXRA now spans research, computation, and code beyond LaTeX.
- **Fable 5 for Claude Code delegation** — Claude Fable 5 is now selectable in the Claude Code integration's model dropdown and the `claude_code` delegation tool's model options, alongside Sonnet 4.6, Opus 4.8, and Haiku 4.5.
- **Cleaner prompts in non-git workspaces** — when a workspace is not a git repository, agents are told so up front and stop attempting git history and status checks that would only fail.
- **Subagents return substantive results** — delegated tool-use subagents now hand back their actual findings and answer to the orchestrator instead of bare status notes like "done," so the orchestrator has something real to act on.

### CLI

#### Features

- **Device-code sign-in and CI relay tokens** — sign in to the CLI by approving a short code in a browser with `texra login --device` (recommended automatically on SSH sessions, and the path to use on WSL2 or inside containers where a local browser redirect cannot complete), and mint long-lived relay tokens for headless CI with `texra setup-token` — list and revoke them with `texra auth token`, and supply one via the `TEXRA_RELAY_TOKEN` environment variable.
- **Give a reason when rejecting an approval** — at a raw (non-TUI) CLI approval prompt you can now type a reason after `n` (for example, `n try a smaller change`), or be prompted for one, and it is passed back to the agent instead of a bare rejection.

#### Bug Fixes

- **One-shot runs stop asking unanswerable questions** — single-agent and team `texra run` invocations now know the session ends after the final response, so they complete the task or state the next command to run instead of finishing with a follow-up question no one can answer.
- **Honest Ctrl-C footer** — the status bar shows "stop" versus "exit" based on whether the run can actually be stopped, instead of offering to stop a run that cannot be.
- **Resume command hints corrected** — the CLI points you to `texra resume <id>` (the supported public command) rather than the removed `--resume` flag form, and `texra resume --help` no longer lists headless-only flags (`--print`, `--output-format`) that do not apply to interactive resume.
- **Workflow runs accept instruction files** — `texra workflow run` now supports `--instruction-file`, matching the other run commands.
- **Accurate chat guidance** — idle sessions no longer show the queued-follow-up tip, and `/help` now describes what `Ctrl-C` does correctly.
- **Full history transcripts** — `texra history show --full` prints the complete stored conversation instead of only the final preview.
- **Slash palette recovers after Escape** — closing the slash command palette with `Escape` and retyping no longer sends a stray double-slash chat message; the command form reopens as expected.
- **Steadier approval prompts** — long plan objectives in the approval prompt now wrap to the terminal width and clear cleanly on redraw, and the subagent-proposal box no longer changes width as you scroll through it.
- **Consistent "idle" subagent label** — the subagent panel and child-control pickers now show a waiting subagent as `idle`, matching the rest of the CLI, instead of `waiting`.
- **Clearer stopped-subagent input** — when a subagent is stopped, the disabled input explains why instead of going silently inert, and `Escape` no longer swallows your keyboard shortcuts.
- **No more spurious resize warning** — the chat TUI no longer prints a stray runtime warning to your terminal when many panels are open.
- **Idle exits report success** — leaving an idle chat session with `Ctrl+C` after a completed turn now exits with a success code instead of the interrupt code (130).
- **Bundled agents refresh on upgrade** — upgrading the CLI now refreshes its bundled workflow and tool-use agent definitions instead of leaving stale copies in place.
- **Homebrew installs get the right upgrade command** — the in-session update prompt now recognizes a Homebrew install (the `texra-ai/tap` formula) and offers `brew update && brew upgrade texra` instead of misdetecting it as an npm global and suggesting `npm install -g`, which would have clashed with the brew-managed copy.
- **Live tool rows stay with your prompt** — in-flight tool activity now renders grouped under the prompt that triggered it instead of detaching while the turn streams.
- **Subagent headers show the subagent model** — focusing a subagent in the CLI now shows that subagent's own model in the scrollback header instead of reusing the parent chat model.

#### Improvements

- **Auto-approval state in the status bar** — when an auto-approval bypass is on, the status bar shows a badge for it (`YOLO`, `AUTO-BASH`, or `AUTO-EDIT`) so the active safety policy is visible at a glance.
- **Cleaner queued follow-up status** — the status bar summarizes queued subagent follow-ups instead of showing their raw message markup.
- **Helpful hints for unknown presets** — naming an unknown multi-agent preset now suggests the available presets instead of failing silently.
- **Clearer remote team loading** — when a preset pulls in relay-served agents, the CLI explains what happened and points you to `texra multi-agent inspect` to see the resolved team.

### Extension (VS Code)

#### Features

- **Local Agent Review** — a new Agent Review section in the TeXRA sidebar reviews your working-tree changes against the main branch with an AI agent and lists potential issues in both the Agent Review view and Problems panel. You can dismiss findings, hand one or all findings to a fixing agent, review automatically after each commit, include submodules and untracked files, choose a quick or thorough pass, and pin a dedicated review model.

#### Bug Fixes

- **Progress board header fits narrow panels** — the toolbar actions in a stream's header no longer overflow when the progress view is docked narrow.

#### Improvements

- **Sharper Marketplace icon** — the extension icon is now shipped at 512×512 instead of 128×128, so it no longer looks blurry on the Marketplace listing and high-DPI displays.
- **Tidier webview controls** — the LaTeX diff operations move out of cramped icon rows into labeled button groups beneath the file they act on, main-view actions gain hover tooltips, settings actions use consistent buttons, and the sign-in and workflow banners are laid out more clearly.

### Extension (VS Code)

#### Features

- **Agent Review in the Source Control panel** — the agent review that scans your changes for issues now lives as a **Find Issues** section right in VS Code's Source Control (git) view, next to Changes and Commits (it moved out of the TeXRA sidebar). A new **Find Issues with Options…** action opens quick prompts to set optional free-text instructions, the review approach (Quick / Thorough) for this run, and the branch to diff against — so you can target a one-off review without changing your saved settings. Findings still stream into the panel and the Problems view with the same Fix-with-Agent and Dismiss actions.

## [0.38.7] - 2026-06-11

### Shared (all surfaces)

#### Features

- **Claude Fable 5** — Anthropic's most capable widely released model is now available as a selectable model and is added to the default model list. It runs with always-on adaptive thinking and summarized reasoning, supports the full effort range up to Extra High, and is eligible for context compaction in tool-use mode.
- **Software Engineer team** — a new built-in multi-agent team for the code that accompanies a project (simulations, numerics, data pipelines, scripts, and small libraries). An `engineer` lead plans the work and delegates to specialists: `coder` (implementation, edits, and bug fixes), `codeReviewer` (correctness/security/style review), `testEngineer` (write and maintain tests), `codeSimplifier` (behaviour-preserving cleanup for clarity and reuse), and `progressCheck` (an outside-the-loop audit of what landed versus the goal). Pick it from the Multi-Agent settings tab, or launch it from the CLI with `texra multi-agent run software-engineer`. The local lead and specialists run offline; `progressCheck` loads after `texra login`.

#### Bug Fixes

- **Stopping a run is no longer recorded as an error** — interrupting an agent (stop button, Ctrl+C, closing an idle chat) now consistently records the run as _interrupted_ instead of _error_: history shows the right status, the transcript group ends neutral instead of red, orchestrators see a cancelled subagent as cancelled rather than failed, and the CLI exits with the interrupt code (130) instead of the error code (1).
- **Fix LaTeX Compilation Errors works on latexdiff output** — running the fixer on a generated `latexdiff` file is no longer blocked. Since `latexdiff` itself often emits non-compiling markup (DIF commands inside math, citations, or macro definitions), the fixer now treats the file as a diff artifact: it repairs broken DIF markup in place while keeping the change annotations, and when an error traces back to the original source it fixes the source too so a regenerated diff stays fixed.
- **Orchestrators manage their team reliably** — stopping an orchestrator now stops the entire delegation chain, including subagents of subagents, instead of leaving them running; a waiting orchestrator now learns that a subagent finished without you having to send another message; and when a subagent's output diffs cannot be computed, the orchestrator is told so instead of assuming nothing changed.
- **Goal records are cleaned up with their conversations** — deleting a conversation (or a run from CLI history) now also removes its goal record, so the Goal tab no longer accumulates entries for conversations that no longer exist.
- **Relay streams survive transient hiccups** — a brief transient error on the included relay no longer cuts off an in-flight response.
- **Safer LaTeX cleanup** — inline fenced LaTeX blocks now distinguish environment names like `align` and `aligned` correctly, and `\mathrm{Tr}` / `\mathrm{tr}` cleanup now leaves command definitions intact while still rewriting ordinary usages.

#### Improvements

- **`chat` is now `assistant`, a general-purpose scientific assistant** — the built-in `chat` agent was renamed to `assistant` and upgraded with the broadest toolset of any built-in agent: web search and fetch, Zotero reference management, Wolfram computation, Lean 4 proof tools, word counts (`texcount`), linter diagnostics, PDF opening, persistent memory, planning and todo tracking, full delegation (`delegate_workflow`, `executions`, `accept_run_files`), external AI coding agents (`codex`, `claude_code`), and opt-in GitHub activity subscription — alongside its existing file editing and arXiv/Crossref tools. Its system prompt takes a holistic view of the research workflow, with guidance organized by phase (orient, research, compute, formalize, write, verify, delegate) on top of the established mathematical writing rules. The old `chat` name still resolves to the renamed agent, so existing configs and histories keep working; it remains the CLI's default chat agent under its new name.
- **Stronger Computer Scientist team** — the CS team now bundles the `coder` and `testEngineer` specialists, so its orchestrator can delegate implementing experiment code, fixing bugs in training and ablation scripts, and pinning results down with tests — work the team previously had no dedicated lane for despite its focus on experiments and reproducibility. The `research` agent also joins the roster for analytical derivations (convergence bounds, complexity analysis) with Wolfram-backed verification, matching the Physicist and Mathematician teams.
- **Cheaper default helper model** — the built-in helper model used for auxiliary tasks (session descriptions, instruction polishing, AI-assisted agent creation, and merges) now defaults to DeepSeek V4 Flash (~$0.14/$0.28 per MTok) instead of Sonnet 4.6, cutting the cost of these background calls by roughly 20×. Override it any time from the Models settings tab.
- **Odyssey is now on by default** — Odyssey, the autonomous-continuation mode that lets an agent keep working toward a stated objective across turns until it reports the goal complete, has graduated from experimental and is enabled out of the box. The setting moved from `texra.experimental.odyssey.enabled` to `texra.odyssey.enabled`; if you previously set the old key, your choice is still honored. Set `texra.odyssey.enabled` to `false` to require manual continuation.

### CLI

#### Features

- **Suspend the chat with Ctrl+Z** — press `Ctrl+Z` to drop back to your shell mid-session and `fg` to return; the terminal is handed back cleanly on suspend and the screen repaints on resume.
- **Screen-reader support** — with the `INK_SCREEN_READER` environment variable set, menus and pickers announce their options with selected and disabled states, the chat input reads as a text box, and decorative glyphs are hidden from the reader.

#### Bug Fixes

- **Terminal always restored on exit** — a crash or unexpected exit can no longer leave your shell stuck in raw mode with a hidden cursor or mouse reporting left on.
- **Stopping honors your subagent preference** — stopping an orchestrator now respects the "Keep agents running if I stop the orchestrator" setting instead of always interrupting running subagents.

#### Improvements

- **Plans are now objective documents** — plans describe the goal, approach, and stopping condition; step tracking lives in todos. Old step-list plans are hidden, goal cost caps are removed, and auto-paused goals now print a CLI notice.
- **Thinking indicator** — while the model is in its reasoning phase, the chat TUI now shows an animated `Thinking…` row in the conversation area instead of sitting silent. The phase is detected from provider stream signals where available, so it also works for models whose reasoning never streams any text (e.g. GPT-5 with reasoning summaries disabled).
- **Honest history statuses** — runs that never reached a terminal state (e.g. the process was killed) now show `unknown` in `texra history` instead of being reported as `completed`, and interrupted chat sessions are checked for a resumable record like unfinished ones.
- **Calmer transcript layout** — your messages now render as an inset band with a blank line above and below, tool rows sit directly under the prompt that triggered them, stray blank rows at startup and between turns are gone, and on narrow terminals the status bar shortens its segments (context usage degrades to a bare percentage) before dropping anything.
- **Forgiving slash-command matching** — when nothing starts with what you typed, the palette falls back to substring matches (`/odel` still finds `/model`) and then to the closest typo suggestion (`/hlp` suggests `/help`) instead of going blank; only exact prefix matches run without preview, so a pasted line never triggers a command you didn't see. `/help` now also lists the text-editing shortcuts from the active keymap and the chords for the tasks and subagents panels.
- **Lighter streaming redraws** — while a response streams, only the row that changed re-renders, reducing CPU usage during long responses.

### Desktop

#### Improvements

- **Project settings shared with the CLI** — the desktop app now stores project-level settings in the same `.texra/config.json` the CLI uses, so configuring a project once applies to both; existing desktop workspace settings migrate automatically.

### Extension (VS Code)

#### Bug Fixes

- **In-editor GitHub sign-in works again** — signing in with GitHub through the editor's account flow had been failing with a server configuration error and silently falling back to browser sign-in; it now completes again. Long-standing existing sessions may ask you to sign in one more time.

## [0.38.6] - 2026-06-07

### CLI

#### Features

- **Switch between compatible models during a chat** — use `/model` mid-session to switch to another model from the same provider (e.g., one Anthropic model to another); the change takes effect immediately and persists on resume. Models with a different conversation format are disabled in the picker with a note to start a new chat, and the picker explains when no models are available in the current API mode.
- **Focused subagent view** — focusing a subagent shows only its own transcript; scroll back through earlier output with normal terminal scrolling, search, and mouse wheel. The header names the subagent and its parent, newly started subagents can be focused right away, and tool calls and file reads no longer flood the main conversation while a subagent runs.
- **Skills in chat** — a new `/skills` command lists available skills from your configured sources; picking one applies its instructions to your next request. Any agent run can pull in extra skill folders with `--source`, and `--include-interop` brings in `.agents`, `.claude`, `.codex`, and `.gemini` skills.
- **Startup launcher shows auth and API status** — the launcher now shows your API mode, sign-in status, and a next-step hint at session start so you can see your account state before choosing how to begin.
- **Interactive provider choice on login** — running `texra login` without naming a provider now lets you pick GitHub or Google interactively instead of silently defaulting.
- **Limit history list length** — `texra history list` now accepts `--limit` (or `-n`) to show only the most recent executions.
- **Copy an agent's question from the inquiry prompt** — the inquiry prompt now offers `Ctrl+Y` to copy the agent's full question to your clipboard, with a brief copied or copy-failed indicator.

#### Bug Fixes

- **Reliable multi-line input** — `Shift+Enter` and `Ctrl+J` insert a newline without submitting, and no longer lose text, add a stray line break, or fail in terminals that report these keys in alternate forms. Enter and keypad Enter now submit predictably across more terminals, and pasting multi-line text keeps every line break instead of collapsing lines or submitting early.
- **Escape reliably closes menus and dialogs** — pressing `Escape` now consistently cancels the slash palette, selection menus, approval cards, and other dialogs even in terminals that report Escape differently.
- **Image paste recognizes `Ctrl+V`** — `Ctrl+V` now triggers image paste in the chat input across terminals that send the raw control code.
- **Teams that cannot launch are blocked clearly** — a team no longer silently starts behind a specialist that cannot delegate or degrades to a single agent; teams missing their orchestrator show as unavailable across the list, launcher, and run output and refuse to start with a clear explanation. Read-only context files you provide are now included in the instruction the team receives.
- **Steadier terminal resize** — resizing the terminal no longer causes the chat view to flicker or repaint repeatedly.
- **Resume hint stays on exit** — the `texra --resume <id>` line shown when you leave a chat session no longer flashes and disappears in Ghostty, iTerm2, or Terminal.app; it stays in your terminal scrollback so you can read and copy it.
- **Resilient chat transcript** — a single malformed chat entry now shows a short inline error instead of crashing the whole chat session.
- **Record interrupted subagent runs as interrupted** — a subagent run you interrupt is now saved with an interrupted status in history instead of being marked as completed.
- **Anchored headless inputs** — headless agent runs now reliably read the input and context files you provide and reject files outside the working directory with a clear error.
- **Honor no-color mode** — the interactive chat, setup, init, and orchestration screens now drop colors and styling when you run with `NO_COLOR` or otherwise disable color, instead of emitting color codes anyway.
- **Launcher list shows the right runs** — the recent and resume lists now show only the runs you started yourself (not subagent sessions spawned by team runs), and resumable runs with no input file show their saved description instead of listing no input.
- **Init wizard disables unavailable models** — the `texra init` wizard now greys out models you cannot currently use so you can only select one that will actually run.
- **Bare auth command shows status** — running `texra auth` on its own now reports your account status and accepts flags like `--output-format json`, matching `texra auth status`.
- **Prefer your local skills** — when skills share a name, your project and user skills now take precedence over the bundled ones.
- **Guard the model after changing API mode** — starting a chat after switching between the included relay and personal API keys now checks that your model is available and tells you how to recover if it is not.

#### Improvements

- **Clearer team status and recovery hints** — the launcher now describes each team's status in plain language (ready or unavailable) with readable agent counts, and when a team cannot start because its root cannot delegate, it says the team root is not a delegating agent. The list and inspect output point you to inspecting a preset to see which agents are missing, and suggest signing in to load relay-served agents when a built-in team is incomplete.
- **Clearer agent and team labels** — the agent picker now titles its list by what is available, calls out orchestrator and tool-use agents, labels orchestrators as delegating agents, and refers to the root agent in its guidance. Multi-agent run help, completions, and inspect output now consistently refer to the team root agent, and the status bar and rotating tips point you to `/agent` for choosing the root agent while it can still be changed.
- **Escape hints match what Escape does** — the status bar now shows the correct Escape action for the open panel (skip, cancel, or close), the approval menu labels Escape as cancel, and the slash command palette shows an Escape hint.
- **Tidier slash pickers** — the `/model` and `/agent` pickers no longer stretch across the full width of wide terminals and now share a consistent bordered frame.
- **Readable diff colors** — added and removed lines now use lighter backgrounds with explicit text colors so they stay legible on both light and dark terminals.
- **Cleaner inquiry transcript** — answered and dropped inquiry notices now appear as quiet cyan summary lines instead of looking like a message you typed; question and answer previews collapse to a single line so embedded code blocks no longer break the layout, with each notice pointing to the command for reading the full thread.
- **Root active indicator** — when you focus a stopped subagent while the main run continues, the status bar now shows that the root is still active.
- **Show your account email plainly in doctor** — the `texra doctor` report now displays your signed-in account email in full instead of masking it, while still hiding email addresses that appear elsewhere in the diagnostics.
- **Clearer manual sign-in guidance** — the `--no-browser` login flow now explains that the printed URL must open in a browser that can reach your terminal session, and notes that remote SSH or container users may need to forward the callback port.

### Desktop

#### Features

- **Resume runs from a previous session** — the desktop app can now continue a run started in an earlier session instead of asking you to start over.

### Extension (VS Code)

#### Features

- **Review pasted images before sending** — interactive agents now show pasted images in a Files group so you can review or remove them, and warn you when the selected model cannot read attached images.

#### Bug Fixes

- **Sign-in works from Codespaces and the web** — signing in from GitHub Codespaces or vscode.dev now completes instead of failing partway through.
- **Tidier inline banners** — the sign-in banner and other inline banners no longer render oversized, and the sign-in banner reads more clearly.
- **Mixed image-and-text paste keeps your text** — pasting an image together with text in the webview no longer drops the text.

### Shared (all surfaces)

#### Features

- **Repair workflow rounds when compilation fails** — when a LaTeX compile check fails, the workflow uses the next round to repair the output from the compile log; a new setting lets you turn this on or off.
- **Free relay request size limit** — requests through the included free model access are now capped at 2 MiB, with a clear message suggesting your own API keys for larger requests.

#### Improvements

- **Cleaner session labels** — the short AI-generated session labels shown in the stream tab, history, and progress views are now based on your actual instruction rather than internal prompt scaffolding, so they describe the task more accurately.

## [0.38.5] - 2026-06-04

### Features

- **Independent subagent history in CLI chat** — each subagent in a team run now keeps its own scoped transcript that persists across sessions, so you can focus into a child or subagent stream, jump between them, and review their separate histories. Resuming a subagent continues it where it left off instead of starting over, and interactive team chats are tagged so you always know which run you're in.
- **First-run auth onboarding** — starting a session without credentials now walks you through signing in instead of failing, and new `/login` and `/logout` chat commands (with options like `--no-browser`, `--select-account`, and `--login-hint`) let you manage access without leaving chat.
- **Paste images and large text into chat** — paste a screenshot or other image straight into the chat input and it attaches as a thumbnail chip; large text pastes collapse into a compact chip so the input stays readable. Attachments clear with the draft when you reset.
- **Pipe input into a run** — `texra run` now reads `--input -` from stdin, so you can pipe a file or another command's output straight into a run and compose it with other tools.
- **Filter agents by category** — `texra agents` can now filter the agent list by category, so you can quickly narrow to the kind of agent you want.

### Bug Fixes

- **In-session updates take effect immediately** — accepting the "a new version is available" prompt now restarts `texra` on the freshly installed version, so the session you land in (and its header/`/status`) runs the update instead of silently continuing on the old build until you quit and relaunch by hand.
- **Chat API mode is reported consistently** — the model is now resolved against the same API mode shown in the header and `/status` (an explicit `--api-mode`/env override, otherwise your account default), so a session can no longer pick a model as if in one mode while the UI reports another. The `--api-mode` flag also rejects invalid values, and the model picker only offers models valid for the active mode.
- **Unknown CLI flags are rejected** — mistyped command options and missing values for file flags now fail before the command runs, so typos surface immediately and structured CLI output stays clean for scripts.
- **File-backed multi-agent prompts** — `texra multi-agent run` now accepts `--instruction-file` for long scripted team prompts, matching `texra agents run`.
- **Full CLI command paths in help** — nested command help now shows the complete `texra ...` command in usage banners, so commands like `texra multi-agent run --help` and `texra history show --help` are directly copyable.
- **Your approval policy survives `--no-input`** — passing an explicit `--approval` choice together with `--no-input` now keeps the policy you set instead of silently forcing a default, so non-interactive and scripted runs honor exactly what you asked for. The default approval policy is applied consistently across `texra init` and chat, and negated login flags are honored too.
- **Resume and history pickers only list resumable runs** — already-completed runs no longer clutter the resume/history pickers, so the list shows just the runs you can actually continue, with conversation previews to help you find the right one.
- **CLI chat redraws cleanly on resize** — the terminal now fully repaints on a width change, so resizing no longer leaves stray residue from reflowed lines, and long input wraps at word boundaries.
- **Color honors your environment everywhere** — `--no-color` and `NO_COLOR` are now respected in help text and Markdown rendering as well, and run progress for `--output-format json` is written to stderr so the machine-readable stdout stays clean.
- **Agent and model lookup is more forgiving** — hidden agents now show in `texra agents list` and the chat picker, `texra agents show` prefers listed agents, the `tool_use` category alias is accepted, and empty model lists explain why instead of showing nothing.
- **Failed runs are clearly marked** — failed background agents and failed child rows now show as errors rather than looking stuck or successful, and a focused stopped stream shows its real status.
- **Clearer guidance when something is blocked** — `texra` now warns when multi-agent delegation can't run and when a team preset's availability is degraded, validates skill source paths with readable errors, and gates the included-access launcher behind sign-in.

### Improvements

- **Better defaults and guidance when starting a run** — multi-agent launches show a task example to guide what to type, the simplifier agent is no longer offered as a default team root, buffered menu hotkeys are handled correctly on startup, and setup/auth errors point you to `texra auth status`.
- **Consistent user chat defaults** — CLI user `config.json` chat defaults now honor the same `chat` section and `texra.*` keys as workspace `.texra/config.json` files.
- **User turns stand out in chat** — your messages now render as a full-width reverse-video band that adapts to your terminal's light/dark theme and reflows on resize, making them easy to pick out from the assistant's output when scrolling back.
- **Clearer `texra doctor` diagnostics** — Node.js version reporting and the supported-version check are aligned and consistent across messages.
- **Quieter, more predictable model selection** — the CLI no longer prints noise when it implicitly falls back to a default model, and personal-account model recovery hints are clearer when a configured model isn't available.

## [0.38.4] - 2026-06-01

### Features

- **Run agent teams from CLI chat** — multi-agent orchestration is now first-class in the terminal. Focus into any child or subagent stream and jump between them with shortcuts, browse active and finished runs in a task picker, and inspect a multi-agent run's plan before it executes. Child streams show their own progress, elapsed time, descriptions, and Ctrl-C stop scope, and the team's identity is shown in chat.
- **Pipe input into workflows** — `texra` now accepts content on stdin for workflow input, so you can pipe a file or another command's output straight into a run.
- **Pick the model right after the agent in CLI chat** — choosing the root agent with `/agent` before the first message now flows straight into the model picker, so you set the agent and model together in one step instead of remembering to run `/model` separately. Pressing Esc on the model picker keeps the agent you chose.
- **See remote agents in the CLI** — running remote agents now appear in the CLI instead of being hidden.

### Bug Fixes

- **Ctrl-C always exits cleanly** — pressing Ctrl-C on an idle chat, after a response, or on an interrupt signal now exits cleanly and stops the right scope (root run vs. focused child stream) instead of hanging, and the footer hint stays aligned with the live status.
- **Color respects your environment** — color output is gated per output stream and honors `NO_COLOR`, `FORCE_COLOR`, and `--no-color`, the pager environment is routed correctly, and the `--output-format json|ndjson` stream stays clean for scripts and CI.
- **Edit approvals show their diffs** — edit and tool approval prompts now display the diff, scroll when it's long, and stay readable on cramped terminals so you can see exactly what you're approving.
- **Readable in narrow and compact terminals** — approvals, pickers, task detail, status bars, slash-command forms, and todo panels stay readable and keep their controls visible when the terminal is small, instead of clipping content or pushing the input off-screen.
- **Queued follow-ups stay visible** — follow-ups you queue while a run is active show up in the status bar and a dedicated panel with previews and counts, and idle messages no longer accidentally start a run.
- **Mistyped subcommands get a suggestion** — typo a subcommand and `texra` suggests the closest match instead of just erroring.
- **Privacy in CLI output** — the API account email is redacted, and Gemini function-call debug text is hidden from the transcript.
- **Progress board never silently hides a run's groups** — a run's stage groups always render in the transcript instead of occasionally vanishing, and one run's progress can no longer show up nested under another.

### Improvements

- **Easier crash reports** — a crash now prints a pre-filled report link, and root-level examples and docs ship alongside the CLI.
- **Clearer `texra doctor` diagnostics** — access diagnostics and recovery hints are clearer and stay reachable on small terminals.
- **History shows more context** — the history view now includes a conversation preview and the workspace files involved in each run.
- **Transcript viewer wraps tool output** — long tool output wraps in the Ctrl-T transcript viewer and one-line tool rows render compactly instead of overflowing.

## [0.38.3] - 2026-05-29

### Features

- **"Max" reasoning effort for Opus 4.8** — pick the new top **Max** tier (above Extra High) in the Models tab for the hardest, longest-horizon tasks; it maps to Anthropic's `max` effort, with Extra High remaining as the `xhigh` tier.
- **Live elapsed timer in the CLI chat** — the status bar now shows the seconds elapsed next to `running`, so a long "thinking" turn that streams no text still reads as alive instead of looking frozen.

### Bug Fixes

- **CLI chat redraws cleanly on resize** — fixed leftover Ink live-region residue when the terminal is resized, and cut idle repaint churn.
- **LaTeX math survives in the transcript** — inline `$…$` / `\(…\)` spans are now preserved verbatim in the CLI's Markdown rendering instead of being mangled.
- **Markdown tables size to their content** in the CLI chat, instead of stretching to the full terminal width.
- **Wolfram results always show a summary** — runs that returned only structured data no longer render as an empty line.
- **Clean `--output-format` output** — usage text is routed to stderr on errors so the JSON / NDJSON stream on stdout stays parseable for scripts and CI.
- **Drag-and-drop file selection works** — files dragged from the workspace explorer now land in the workflow Input / Context / Media buckets.
- **Subagent progress boards show their rounds again** — a subagent run's transcript was blank except for the instruction: the round groups (Init, r0/r1) and everything nested under them — scratchpad, statistics, latexdiff results, loaded files — failed to render. The run's root stage was inheriting the orchestrator's active stage as a cross-trace parent, orphaning the whole group tree in the subagent's own stream.

### Improvements

- **Install the CLI straight from the Dashboard** — the TeXRA CLI integration card now shows the `npm install -g @texra-ai/cli` command and an npm link, for running the same agents on your `.tex` projects without an editor.

## [0.38.2] - 2026-05-27

### Features

- **Claude Opus 4.8 support** — the latest Opus 4.8 models (`opus48`, `opus48T`) are available for demanding research and engineering tasks, replacing Opus 4.7 as the default Anthropic model. Opus 4.8 keeps the full 1M context window, adaptive thinking, and native server-side compaction.

- **Stay on the latest CLI** — `texra` notices when a newer version is on npm and offers to update for you.
- **Shift+Enter for newlines** in the CLI chat input — write multi-line prompts without leaving the input.
- **Easier-to-read diffs** — added and removed lines show as full-width green and red bands in the terminal, matching the editor view.
- **See the full output anytime** — press **Ctrl+T** in the CLI chat to view a tool's complete output when it's shown shortened.
- **Tables render in the terminal** — Markdown tables now show as proper bordered tables in the CLI chat.

### Bug Fixes

- **Workflow rounds no longer overwrite the workspace** — past round 0, a workflow agent's emitted documents were being written through a symlink chain that ended at your live workspace file. The round directory's outputs are now real files owned by the round, and the workspace is unreachable from the backend.

- **Ctrl+C works on modern terminals again** — cancel a run or exit `texra chat` on kitty, WezTerm, and Ghostty.
- **Approval prompts stay compact** — they no longer stretch to fill the terminal and push the input off-screen.
- **No more empty "(no output)" lines** in the chat transcript for tools that intentionally hide their output.
- **Readable text in high-contrast themes** — user messages no longer blend into the background.

## [0.38.1] - 2026-05-27

### Features

- **CLI tools, memory, and init** — new `texra tools` (`list`, `show`, `enable`, `disable`, `install`, `auth`) and `texra memory` (`list`, `show`) command groups, plus a `texra init` wizard that writes `.texra/config.json` and gitignores it. The TUI gets a matching `/tools` slash command.

### Bug Fixes

- Bug fixes on settings tabs loading, "Compare with base" diffing against the live workspace file, and progress-log replay preserving initial entries.

### Improvements

- **Cleaner history rows** — restructured layout with metadata on top, inline Context/Config, and collapsible long prompts.
- **Merge shows up on the progress board** — runs now appear as a normal task and save their result under the input filename.
- **CLI auth grouped under `texra auth`** — `login`, `logout`, `status`, and `usage` now live under `texra auth` (top-level `texra login` / `texra logout` kept as shortcuts). Clearer `--approval-policy` help, safer defaults, and disambiguated `--output` vs `--output-dir`.

## [0.38.0] - 2026-05-24

### Features

- **Export chat history as a shareable webpage** — Settings → History gets a new HTML export button alongside Markdown and PDF. The export uses the same markdown / KaTeX / syntax-highlighting pipeline as the in-app webview, ships its own CSS + fonts, and opens straight in your browser so you can share or demo a project run with anyone.

## [0.37.10] - 2026-05-23

### Features

- **Approve & Run a plan** — plan approval cards have a new **Approve & Run** button (in Odyssey mode) that approves the plan and lets the agent work through every step on its own.
- **Orchestrators can hand off to Claude Code** — built-in orchestrator agents can delegate a sub-task to Claude Code when that's the better tool for the job.

### Improvements

- **Quota shown as a percentage** — Settings → Models tells you how much of your monthly included-model quota you've used as a percentage rather than a dollar amount.
- **Less prominent Odyssey settings tab** — the Odyssey tab now sits at the end of Settings so the everyday tabs come first.

### Bug Fixes

- **Sensible defaults when something is missing** — empty model lists and missing-agent sessions fall back to a working default.
- **More reliable tool calls** — fixes tool-call failures on Anthropic, Gemini, and OpenAI (including GPT reasoning models) for tools with complex arguments.
- **Old workflow outputs load correctly** — outputs saved by older versions open again.
- **Stopping a run isn't an error** — interrupting an agent is treated as a cancellation.
- **Welcome walkthrough stays reachable** — easy to find again from the editor's walkthrough list.

## [0.37.9] - 2026-05-18

### Features

- **See your relay quota at a glance** — Settings → Models shows how much of your monthly included-model quota you've used. When it runs out, TeXRA quietly switches to your own API keys so runs don't fail mid-task.

### Improvements

- **Cleaner Settings view** — tighter layouts across tabs, and the README now opens directly inside the extension.
- **Simpler launcher** — the input and output file panels are easier to read at a glance.
- **See your workflow PDF** — when a workflow run produces a PDF, you can open it directly from the run.

## [0.37.8] - 2026-05-17

### Breaking Changes

- **Sessions and agent configurations from very old extension versions may not load** — TeXRA no longer migrates them on the fly. If a saved session or agent config refuses to load after upgrading, recreate it.

### Features

- **Odyssey mode** — let an agent run a long task to completion on its own. A budget auto-pauses the run for your approval before going further, and a dedicated panel shows progress so you can step in any time.
- **Integrations settings tab** — a new **Settings → Integrations** tab groups external agent integrations (Codex CLI, Claude Code CLI, External Inquiry) in one place, with reasoning-effort and adaptive-thinking controls for Claude Code CLI.
- **Ask-user-question tool** — agents can now ask you a multiple-choice question mid-run instead of guessing.
- **Ink-based CLI TUI is the default** — `texra chat` now uses the Ink TUI for interactive sessions, with a
  multi-pane layout, structured slash forms, persistent input history, and shared key hints. Deprecated renderer flags
  are still accepted for compatibility.
- **Non-blocking inquiries** — when an agent sends you to ChatGPT/Gemini/etc. for outside help (now called **Inquiry**), the run no longer freezes waiting for your reply. The agent keeps working and is woken with a follow-up when you submit the answer — even after closing the tab or reloading. Inquiry threads appear in **Background tasks** with full transcripts and saved drafts per thread.
- **Open PDF from an agent** — agents can open a finished PDF in your viewer.
- **LaTeXdiff focuses on changed pages** — generated diff PDFs now show only the pages that actually changed.
- **Worktree chip on stream tabs** — when an agent runs in a git worktree, its stream tab shows the branch name and a dirty-status indicator.

### Improvements

- **General performance and reliability improvements.**
- **Bash runs in Executions** — shell commands run by an agent now show up as their own process with a dedicated stream tab instead of being folded into the calling agent's output.
- **Single-slot workflow output keeps the original filename** — edit-style workflows write back to the input file's name instead of generating a duplicate under a generic name.
- **Pack and Clean show what each input is for** — input slots in the launcher are labeled instead of unnamed.
- **Settings polish** — more compact retry details and dropdowns, longer memory previews, reliability controls now live on the Models tab, and agent proposal instructions render as markdown.
- **Long shell commands wrap** — tool-use titles no longer truncate long commands with an ellipsis.
- **Progress view first-run state** — with no runs yet, the progress view shows direct actions to open the Launcher or Dashboard instead of an empty board.

### Bug Fixes

- **Recover from retryable tool errors** — when a tool call fails with a resumable error, you can now send a follow-up to nudge the agent past it instead of being stuck.
- **LaTeXdiff doesn't litter your workspace** — intermediate sources stay in run storage instead of appearing next to your files.
- **CLI workflow output paths** — `texra run` now prints the final workflow output path from run storage, so
  multi-round workflow output remains unambiguous.
- **Cleaner progress summaries** — long bash output no longer floods the rolling summary at the top of a run.
- **Current DeepSeek V4 pricing** — V4 Flash and Pro now use DeepSeek's current cache-hit and discounted rates.
- **Codicon font packaging** — toolbar and settings icons render correctly in installed builds instead of fallback squares.

## [0.37.7] - 2026-05-01

### Features

- **GitHub subscription for repos and issues** — ask an agent to watch a repository or issue and it will receive activity (comments, state changes, CI results) as follow-ups while it works. Use `owner/repo` to monitor a whole repo, or `owner/repo/issues/N` for a specific issue — the same way PR subscriptions already work. Open Settings → Git to see what's being watched and stop any subscription.
- **Compile & Diff settings in the UI** — LaTeX compile and diff options (auto-compile after each round, timeouts, latexdiff math-markup mode, formatter choice) can now be configured in Settings → LaTeX under **Compile & Diff** without touching `settings.json`. Settings are per-workspace and take effect immediately.
- **Working directory shown on delegation proposals** — when a delegated agent will run in a specific directory, that path now appears on the proposal and permission cards before you approve, so you can confirm it's correct.
- **Send follow-ups freely during delegation** — you can now queue multiple messages while a delegated agent is working; they are delivered in order once it's ready, instead of later messages being silently dropped.

### Bug Fixes

- **Workflow outputs stay out of your workspace until accepted** — generated files remain in run storage and your source files are not marked as modified until you explicitly accept the output.
- **Disk-full errors show an actionable message** — a full disk now produces a clear "free up disk space" notification instead of a raw error, and no retry is attempted.
- **Various smaller fixes** — stable toggle icons; reliable DeepSeek reasoning output; LaTeX fixer button always enabled when appropriate; AI responses no longer silently drop tool calls; no extra approval prompt between orchestrator and delegated subtask; follow-up input wraps long URLs, paths, and pasted log output instead of overflowing the panel; progress board recovers from corrupted or outdated saved state instead of crashing on startup.

## [0.37.6] - 2026-04-27

### Features

- **GPT-5.5 Pro** — OpenAI's GPT-5.5 Pro (`gpt55pro`) is now available in the model catalog as an opt-in choice for the hardest planning, long-horizon, and large-codebase tasks. It extends GPT-5.5 with a 1.05M-token context window and `xhigh` default reasoning effort. Premium pricing ($30/M input, $180/M output); available on premium plans — enable it from Settings → Models when GPT-5.5 isn't enough.
- **Computer Scientist multi-agent preset** — a new built-in team preset tuned for empirical computer science work pairs a numerics agent for code-driven experiments with a search agent for literature and a review/criticize agent for methodology and baseline scrutiny.
- **Setup assistant can run terminal commands** — the setup wizard can now hand off sudo prompts and interactive installers to your VS Code terminal instead of stalling on them.

### Improvements

- **Premium-pricing advisory for GPT Pro models** — `gpt5pro`, `gpt52pro`, and `gpt55pro` now show a warning in the model dropdown tooltip and the Settings → Models tab pointing users to the External Inquiry tool, which lets agents ask you to paste an answer from your own ChatGPT subscription instead of paying per-token API rates for these flagship Pro models.
- **Friendlier first-run experience** — the status bar now shows a "Get Started" button that opens the setup assistant for both sign-in and API-key flows; if agents fail to load you get a dismissible notification with Retry and View Logs actions; and the welcome view lists numbered next steps instead of a generic message.
- **Model labels in selection lists** — model labels (e.g. "Fastest", "Balanced") now appear alongside model names in the Settings → Models selection list so you can tell at a glance what each choice is optimised for.
- **Recent runs shown first** — the progress board now lists your most recent runs at the top.
- **Scrollable command output** — long command output in the progress board scrolls independently, and you can copy it in formatted or plain-text form.
- **More reliable follow-ups during delegation** — messages sent while a delegated agent is still working are queued and delivered once it's ready, instead of being dropped.
- **Settings UI polish** — model and agent dropdowns are wider; model labels appear in run tab headers; the GitHub tools section shows prerequisite hints; and the Multi-Agent tab layout is more compact and consistent.
- **API setup guidance in Models tab** — a hint banner appears in Settings → Models when no API key is detected, giving users a direct path to configuration.
- **External Inquiry quick-links** — the External Inquiry panel now includes direct links to documentation so users know when and how to use it.

### Bug Fixes

- **Progress board fails to open after a crash** — TeXRA now recovers cleanly if its saved state was corrupted by an unexpected shutdown, so the progress board always opens on startup.
- **Agent panels stuck open after delegation** — panels from completed delegated work now close properly and can no longer get stuck mid-initialisation.
- **GitHub status stale in Settings** — the GitHub connection status now refreshes each time you open Settings instead of showing outdated information.

## [0.37.5] - 2026-04-24

### Breaking Changes

- **Workflow outputs stay in task storage** — generated workflow files no
  longer appear directly beside your source files. Review them from the
  progress view, open the run's task storage folder, accept selected outputs,
  or pack the run into `History/`.

### Features

- **GPT-5.5** — OpenAI's GPT-5.5 (`gpt55`) is now the flagship OpenAI model in the default lineup. It reaches strong results with fewer reasoning tokens, follows instructions more literally, is more precise on large tool surfaces, and produces more polished and concise answers by default. The default reasoning effort is **medium** — raise to `high`/`xhigh` only when it makes a measurable difference. Image inputs preserve more visual detail by default, improving figure and screenshot understanding. The [TeXRA CLI](https://texra.ai/guide/texra-cli) integration uses `gpt-5.5` for delegated Codex turns. GPT-5.4 (`gpt54`, `gpt54-`, `gpt54--`) remains available as a lower-cost option.
- **Terminal-quality command output** — command-heavy runs are much easier to read, especially during builds, installs, and diagnostics.
- **Clearer pull-request awareness** — GitHub-related work is easier to monitor and return to from the settings and progress views.
- **DeepSeek V4 models** — DeepSeek V4 Flash and DeepSeek V4 Pro are now available in the model catalog.

### Improvements

- **More guided first run** — the welcome banner now surfaces the setup walkthrough so new users can step through environment, tools, and model access without hunting for it.
- **More dependable long-running work** — extended agent sessions recover more smoothly from interruptions and ambiguous turns.
- **Sharper model defaults** — new and upgrading users get a cleaner default model lineup while advanced options remain available.
- **Sharper literature workflows** — agents are better at turning full-paper context into focused, usable research guidance.
- **More helpful guidance** — setup, orchestration, Git, LaTeX, and Lean workflows now present clearer next steps.
- **More polished progress UI** — streams, controls, and dropdowns are more compact, consistent, and easier to scan, and session hints dismiss with a subtler control.
- **Quieter diagnostics** — routine messages stay out of the way, and user-facing errors focus on recovery.

### Bug Fixes

- **More reliable workflow history** — older workflow tabs recover their context more consistently.
- **Settings refresh fixes** — API key, agent, model, and GitHub changes now update related UI state more reliably.
- **More robust PR workflows** — temporary GitHub failures are handled more gracefully.
- **Restored output and diff displays** — generated outputs and diff views display correctly again.
- **Cleaner command-stream labels** — background command streams no longer show irrelevant labels.
- **More complete chat exports** — exported conversations preserve more of the visible interaction.
- **DeepSeek cache reporting** — DeepSeek V4 Flash and DeepSeek V4 Pro usage now distinguishes prompt-cache hits and misses more clearly.
- **Fuller Anthropic responses** — prefilled content now reaches the final output instead of being dropped.
- **Crisper terminal-style logs** — command output is easier to scan and no longer runs together.
- **Smarter delegation choices** — the orchestrator reaches for a real agent when one fits the task.

## [0.37.4] - 2026-04-21

### Breaking Changes

- **Workflow outputs now live in run history** — workflow results are kept with the run that produced them, giving you a cleaner workspace and a clearer review path through the progress view.

### Features

- **Guided first-run setup** — TeXRA can now walk users through environment checks, missing tools, and model access with a more guided setup experience.
- **Higher-confidence workflow review** — generated LaTeX opens naturally, is easier to inspect, and is checked more consistently before acceptance.
- **A more capable team experience** — multi-agent workflows now feel more like coordinated teams, with clearer proposals and better handoffs.
- **Richer project awareness** — TeXRA surfaces more useful context across the sidebar, Explorer, and progress view while agents work.
- **Pull-request collaboration support** — agents can help keep PR work moving with less manual monitoring.
- **Claude Opus 4.7 support** — the latest Opus 4.7 models are available for demanding research and engineering tasks.
- **Better isolation for advanced delegation** — larger multi-agent runs can keep parallel work better separated when configured.

### Improvements

- **Smoother Codex orchestration** — Codex-backed work fits more naturally into long multi-agent sessions.
- **Safer workspace activation** — TeXRA now waits for trusted workspaces before enabling agent features.
- **Cleaner first-run defaults** — optional integrations that need extra setup are quieter for new users.
- **More durable long workflows** — long-running model work is handled more robustly.
- **More readable progress surfaces** — workflow instructions, selected tabs, history, and webview styling are easier to scan.

### Bug Fixes

- **More reliable workflow builds** — assets and related files are handled better during workflow review.
- **Better compact layouts** — child streams collapse and reopen more predictably.
- **Persistent sidebar placement** — VS Code restores the TeXRA sidebar location more reliably.
- **Cleaner command palette behavior** — TeXRA commands no longer appear before the extension is ready.
- **More reliable GitHub updates** — CI and review activity are tracked more consistently.
- **Clearer cancellation behavior** — cancelled requests no longer become generic provider errors.
- **More reliable relay routing** — provider-prefixed model IDs route correctly through relay.
- **Proposal and toolbar polish** — stream toolbar state and proposal-card layout behave more consistently.
- **More reliable follow-ups** — messages sent during delegated work are handled more gracefully.
- **Thinking-model display fixes** — reasoning summaries are visible again for supported thinking models.
- **More robust Codex effort handling** — higher effort settings no longer break Codex sessions.
- **Helper-agent loading fixes** — built-in helper agents validate and load properly again.

## [0.37.3] - 2026-04-15

### Features

- **Better multi-file paper support** — workflow agents handle papers with shared files and bibliographies more reliably.
- **More flexible arXiv downloads** — downloaded papers can be saved where they fit your project organization.
- **Remote-agent transparency** — premium users can inspect the prompt sent to a remote agent.
- **Settings import** — settings can now be loaded from a saved file.

### Improvements

- **Long-paper handling is more reliable** — large documents are processed more smoothly.
- **More careful orchestration** — the orchestrator asks for clarification more often when a request is ambiguous.
- **Dismissed banners stay dismissed** — onboarding and info banners respect your choices across sessions.

### Bug Fixes

- Fixed stale run state sometimes affecting new agent runs.

## [0.37.2] - 2026-04-09

### Features

- **Orchestrator-first onboarding** — new users are guided toward the orchestrator as the default starting point.
- **Codex effort setting** — Codex runs can now use configurable reasoning effort.
- **More responsive follow-ups** — follow-up messages interrupt waiting agents more reliably.
- **New Codex skill presets** — additional ready-made Codex workflows are available for research and Lean work.

### Improvements

- **Clearer labels and terminology** — agent modes, approvals, settings, and warnings are easier to understand.
- **Improved orchestrator UX** — orchestrator guidance and mode-specific instructions are more consistent.
- **Richer Codex display** — Codex activity is easier to inspect in the progress view.
- **Better error messages** — common setup and agent errors now include clearer next steps.
- **Tighter stream tabs** — progress tabs use space more efficiently.

### Bug Fixes

- Fixed an activation issue that could prevent TeXRA from starting correctly.

## [0.37.0] - 2026-04-04

### Features

- **External AI consultations** — agents can help coordinate questions to external AI services from within a TeXRA session.
- **Redesigned Codex experience** — Codex work is easier to follow, continue, and review inside TeXRA.
- **Expanded model routing** — OpenRouter support is now more deeply integrated.

### Improvements

- **Better organization for concurrent work** — related background activity and delegated work are easier to follow in the progress view.
- **More responsive long-running output** — background command output appears more naturally while work is still running.
- **Improved performance with many streams** — the sidebar stays responsive with large active sessions.
- **Tool toggles** — individual tools can now be enabled or disabled from the Tools settings tab.
- **More self-contained document outputs** — generated documents are easier to understand without reading the full conversation.

### Bug Fixes

- Fixed Codex sessions occasionally hanging or duplicating work.
- Stopping background work is more reliable.
- Resolving one external consultation no longer changes the active response unexpectedly.

## [0.36.10] - 2026-03-28

### Features

- **OpenRouter provider** — new toggle in model settings to route all API calls through OpenRouter, letting you use a single API key for any supported model.

### Improvements

- Updated dependencies (KaTeX, Codex SDK, OpenRouter SDK).

## [0.36.9] - 2026-03-26

### Features

- **Context compactization for OpenAI-compatible models** — DeepSeek, Kimi, GLM, and MiniMax models now support automatic context compactization, preventing long tool-use sessions from hitting context window limits. The model summarizes older messages when token usage exceeds 75% of the context window.
- **Wait for specific background executions** — the `executions` tool's wait action now accepts an optional `ids` parameter to monitor specific background tasks instead of waiting for any active execution.
- **MiniMax reasoning split** — MiniMax thinking models now return structured reasoning content instead of embedded `<think>` tags, improving display and downstream processing.

### Bug Fixes

- Fixed Codex CLI not being detected for WSL users.
- Fixed tool-use agent errors ending the conversation instead of allowing follow-up messages to retry.
- Fixed workflow delegation losing extract-figure flags when the LLM omitted them, now inheriting from the parent agent.

### Improvements

- **Extract figure badges in delegation UI** — workflow proposals now show labeled badges for auto-extract figure and TikZ flags in the approval panel and log entries.
- **Better Codex tool display** — Codex processes show a robot icon in the background tasks panel and display structured prompt details in the progress view.
- Updated VS Code engine requirement to 1.105.0.
- Updated dependencies (Supabase, Hono, MCP SDK, fast-xml-parser, KaTeX, OpenAI, Vite, and others).

## [0.36.8] - 2026-03-23

### Features

- **MiniMax and GLM model providers** — added MiniMax and Zhipu AI (GLM) as model providers, with region toggles for China and international endpoints.
- **Zotero collections browser** — agents can now browse your Zotero collection folders to discover and organize references before adding papers.
- **Email file support** — attach or read `.eml` email files directly; TeXRA extracts headers, body text, and image attachments into readable content.
- **Git author attribution** — new option in the Git settings tab to mark commits made by TeXRA with a custom author name and email, so agent-authored changes are easy to identify.
- **LaTeX asset extraction in workflows** — workflow agents can automatically extract referenced figures and TikZ diagrams when delegating tasks, with toggles in the delegation UI.
- **Paginated listings** — history, memory, and tool execution lists now paginate instead of loading everything at once, keeping the interface responsive with large collections.

### Bug Fixes

- Fixed git settings checkbox staying disabled after reopening the settings panel.
- Fixed rare crash during agent conversations.
- Fixed agents occasionally launching in the wrong execution mode.
- Fixed background agents continuing to run after closing their stream tabs.

### Improvements

- **Helper model validation** — TeXRA now checks credentials before starting a task, showing clear messages like "API key missing" instead of failing mid-run.
- **File tracking in multi-agent workflows** — the orchestrator now reports which files each sub-task edited, so you can review changes at a glance.
- **arXiv paper organization** — downloaded arXiv papers are saved into a `References/` subdirectory instead of the workspace root.
- **Cleaner stream switching** — plan and todo sections collapse when switching between stream tabs to reduce clutter.
- **Execution timing** — terminal and sub-task results now show how long they took to run.
- **Better resource cleanup** — closing the extension properly stops background processes to prevent memory leaks.
- Updated dependencies.

## [0.36.7] - 2026-03-17

### Features

- **LaTeX error fixer** — new title bar button for `.tex` files that automatically compiles, diagnoses, and fixes errors, warnings, and overfull boxes.
- **OpenAI Codex tool** — agents can use OpenAI's Codex CLI for sandboxed code execution with streaming output.
- **Pinnable memories** — pin up to 10 memories per workspace so they are always included at session start.
- **Memory attachments for delegated tasks** — attach memory files to sub-tasks so agents inherit project conventions and knowledge.
- **Short model names** — toggle in the Models tab to use unpinned identifiers (e.g., `gpt-5.4` instead of `gpt-5.4-2026-03-05`), useful for proxies that don't accept dated names.
- **DashScope China region (Bailian)** — toggle in DashScope settings to switch between international and China endpoints.
- **Copy user messages** — copy-to-clipboard button on hover for user messages in the Progress Board.
- **Output diffs in multi-agent workflows** — changed files from completed sub-tasks are shown as diffs for quick review.
- **Project context in bash** — `$PROJECT_DIR` and `$PROJECT_NAME` environment variables available in agent bash sessions.
- **Selection descriptions** — agent and model selectors now show a brief description below the dropdowns.

### Bug Fixes

- Fixed latexdiff failing with files in subdirectories.
- Fixed Codex CLI errors on first use and during long sessions.
- Fixed history view showing empty file fields for tool-use sessions.
- Fixed editor tabs stealing focus when agents open files.
- Fixed retry logic misclassifying non-retryable Anthropic errors (e.g., `invalid_request_error`) as retryable.

### Improvements

- **Markdown in history and memories** — instructions and memory previews render as formatted markdown with syntax highlighting.
- **Overleaf Git token setup** — prompts and error messages now link to Overleaf's token documentation.
- **Session descriptions for all agents** — delegated agents now show auto-generated descriptions in their progress tabs.
- **Lower Anthropic costs** — Opus 4.6 and Sonnet 4.6 use native 1M context without a long-context premium. PDF limit raised to 600 pages.
- **Terminal respects your theme** — terminal output uses VS Code theme colors, fixing readability in light themes.
- **Agents stay on track in long sessions** — todo list and plan are preserved when the conversation is compacted.
- **Scrollable panels** — long plans, bash commands, and permission panels scroll instead of pushing buttons off screen. Panels auto-expand when new information arrives.
- Removed Wolfram provider key configuration (the WolframScript tool remains).
- Improved writing quality and consistency across agents.
- Updated dependencies (`@google/genai` 1.46.0, `llm-zoo` 1.1.4, `openai` 6.32.0).

## [0.36.6] - 2026-03-12

### Features

- **Background tasks panel** — a new collapsible panel in the Progress Board shows running background processes and subagents with real-time terminal output streaming, so you can monitor what's happening without switching tabs.
- **Office document attachments** — attach Word, Excel, PowerPoint, and other office documents directly in file attachments alongside images and PDFs.
- **WebSocket mode for OpenAI** — enable persistent WebSocket connections (`texra.model.useWebSocket`) for lower-latency streaming with OpenAI models, especially in multi-turn tool-use workflows.
- **Session descriptions in stream tabs** — each agent session now generates a short description from your instruction, shown in the stream tab for easier identification. Cancelled or errored sessions get descriptions too.
- **Multi-provider chat export** — chat export now works correctly with Google GenAI, OpenAI, and Anthropic conversations.

### Bug Fixes

- Fixed **pending approvals being dropped** when the editor panel closed and fell back to the sidebar.

### Improvements

- **Lower costs with Anthropic models** — prompt caching is now handled more efficiently, reducing token usage in long conversations.
- **Agents stay aware during long conversations** — after context is compacted in long sessions, agents now retain a summary of running subagents and background processes instead of losing track of them.
- Updated dependencies.

## [0.36.5] - 2026-03-08

### Features

- **GPT-5.4** — added OpenAI's GPT-5.4 (`gpt54`) and GPT-5.4 Pro (`gpt54pro`) to the default model list. GPT-5.4 is OpenAI's most capable model, with 1M token context, native computer-use, and improved professional-task performance. GPT-5.4 Pro offers maximum performance for complex workloads.
- GPT-5.2 and GPT-5.2 Pro have been removed from the default list (still usable if manually added). GPT-5.3 Codex remains as the recommended coding model.
- **Chat export** — export agent conversations to Markdown or LaTeX/PDF formats.
- **Approval indicators** — stream tabs now show a pulsing orange border when an approval is pending, and auto-focus to the requesting tab.

### Bug Fixes

- Bug fixes in diff view focus, custom endpoint resolution, approval toggle state, and Anthropic web tool handling.

### Improvements

- Updated dependencies.

## [0.36.4] - 2026-03-02

### Features

- **Reasoning level overrides** — configure the reasoning effort (Low / Medium / High) per model in the Models settings tab, overriding each provider's default.
- **GPT-5.3 Codex** — added OpenAI's GPT-5.3-Codex (`gpt53codex`) to the default model list.

### Bug Fixes

- Fixed **incomplete Anthropic responses** not being detected — truncated streams are now caught and retried automatically.
- Fixed **image uploads rejected** when the configured resize dimension exceeded 8000 px — the limit is now capped to stay within API bounds.
- Fixed **approval and instruction panels** disappearing or not appearing in the progress board — diff previews, subagent launches, and stream switches no longer dismiss pending approvals or drop instruction data.
- Fixed **Google GenAI retry multiplication** — the configured retry count is now respected instead of being silently multiplied.

### Improvements

- **Inline base64 fallback for tool attachments** — images and PDFs from tool results are now embedded inline when routed through providers (e.g., OpenRouter) that lack file-upload support, so the model can see visual content.
- **Clearer delegation feedback** — the orchestrator now receives more accurate status signals, rejection details, and approval metadata when delegating to subagents, improving multi-agent coordination.

## [0.36.3] - 2026-02-23

### Features

- **Resume agent tool** — the orchestrator can now send follow-up instructions to paused subagents, continuing where they left off without starting over.
- **LaTeX settings tab** — new Settings tab showing recommended LaTeX configuration with one-click apply, plus dependency status for LaTeX Workshop and latexdiff.
- **Gemini 3.1 Pro** — added as default Google model, replacing the deprecated Gemini 3 Pro.
- **Parallel tool call limits** — configure how many tools OpenAI models can call at once in Multi-Agent settings.
- **Orchestrator kill toggle** — control whether the orchestrator can terminate subagent runs from Multi-Agent settings.
- **Tool availability checks** — missing dependencies (Wolfram, Lean) are detected automatically with one-click install prompts instead of confusing errors.
- **leanBlueprint agent** — new Lean 4 agent for blueprint-driven formalization, available in the lean-project and mathematician presets.
- **Presenter bash support** — the presenter agent can now run bash commands for building and previewing slides.

### Bug Fixes

- Fixed user messages appearing out of order in tool-use conversations instead of interleaving chronologically with tool outputs.
- Fixed arXiv fetcher not reporting already-downloaded papers and incorrectly rejecting PDF-only papers.

### Improvements

- **Progress Board is noticeably faster** — streaming updates, tab switching, and large conversations all render more smoothly.
- **Keyboard accessibility** — added focus indicators, hover states on interactive elements, and a confirmation dialog before API key removal.
- **Better tool error messages** — clearer installation guides and actionable steps when external tools are missing.
- Updated dependencies.

## [0.36.2] - 2026-02-17

### Features

- **Agent management** — save/load/delete custom agent presets from the Multi-Agent tab, create agents via a guided wizard, and customize or delete them directly in Settings > Agents with per-source bulk toggles.
- **Tool Dashboard** — new settings tab showing which external tools (LaTeX, Git, Lean, Zotero, etc.) are installed and available on your system.
- **Live subagent visibility** — agent sessions are auto-summarized, and the orchestrator sees real-time cost, tool-call, and file-interaction updates from running subagents.
- **Orchestrator memory** — orchestrator agents record experience gathered during sessions, improving results across future runs.
- **New agents** — added leanSearch, leanSimplifier, and presenter for Lean 4 research, proof simplification, and interactive Beamer presentation building.
- **Terminal output rendering** — bash and shell output in the Progress Board now renders with full ANSI color and formatting support.
- **Beamer theme** — paper2slide now uses the modern metropolis theme.
- Added **Claude Sonnet 4.6** (`sonnet46`, `sonnet46T`) with server-side context compaction and 1M context window beta support.

### Bug Fixes

- Fixed **stream tab animations** not playing and **message updates being dropped** for grouped messages in multi-agent scenarios.
- Agents no longer crash when hitting the **PDF page limit** — instead they receive a helpful message suggesting compaction.
- **arXiv sources** are no longer re-downloaded when the files already exist locally.
- Fixed **context window detection** for OpenAI Responses API models.
- Fixed a crash in **environments without a home directory** (e.g., Docker containers).
- Fixed **LaTeX path detection** — auto-detects TeX installation paths across macOS, Linux, and Windows; non-workspace files now resolve project-local `.sty`, `.cls`, and `.bib` files correctly.
- Fixed several **Windows / WSL issues** — line-ending normalization and path handling now work correctly.
- Fixed agents **not stopping properly** — no longer run extra rounds after a failure or ignore the interrupted status.
- **Authentication errors** no longer trigger repeated retries; only transient network failures are retried.
- Fixed **keyboard shortcuts** sometimes being routed to the wrong panel.
- Fixed **model dropdown** not appearing for users with personal API keys but no TeXRA account.
- Fixed interrupted sessions losing their **conversation history** — previous messages are now preserved so you can review what happened.

### Improvements

- **Multi-agent UI is noticeably faster** — switching between agents and receiving updates stays responsive even with many concurrent streams.
- **Pack and Clean discoverability** — renamed commands to be more descriptive, added keyboard shortcuts (Ctrl+Alt+Shift+C/B), and made them accessible from editor title menus, context menus, and the getting-started walkthrough.
- **Memory tool safety** — agents must now view a memory file before deleting or renaming it.
- **Error messages from tools** are now clearer and suggest concrete next steps.
- Updated dependencies.

## [0.36.1] - 2026-02-13

### Bug Fixes

- Fixed model dropdown availability.

## [0.36.0] - 2026-02-12

### Features

- Added **review agent** for manuscript verification — checks mathematical correctness, derivation soundness, notation consistency, and code-manuscript consistency.
- Added **Super YOLO mode** for auto-approving agent proposals without user interaction, with per-stream toggle and settings in the Multi-Agent tab.
- **Subagent model inheritance** — delegated agents now default to the parent agent's model.
- Added **reliability settings** (compaction threshold, retry attempts, retry backoff) to the Multi-Agent tab.
- Added **parent agent breadcrumbs** on subagent stream tabs with clickable navigation back to the parent stream.
- Added **modification timestamps** and column headers to memory tool directory listings.
- Added **execution management** — orchestrator agents can now wait for, inspect, and terminate subagent runs.
- Added **active process badges** in the progress view.

### Bug Fixes

- Fixed **Kimi tool-use** causing API errors on parallel tool calls.
- Fixed **manual compaction** trigger not being honored.
- Fixed **gzip-only arXiv sources** not decompressing correctly for single-file downloads.
- Fixed **Overleaf/ShareLaTeX project URLs** — clone dialog now accepts standard project URLs; auth failures show a "Get Token" button.
- Fixed **Super YOLO toggle** not syncing state on stream switch or webview reload.
- Fixed **parent stream link** persistence across extension restarts.
- Fixed **stream-switch events** from parent breadcrumb links not working in split layout.
- Fixed **stream diagnostics** showing when no events were processed.

### Improvements

- Removed **deprecated models** (sonnet45, opus46, kimi25, qwen3max) from the default model list.
- Suppressed **file lineage** display for non-rewrite agents.
- Updated dependencies.

## [0.35.10] - 2026-02-10

### Features

- Added **agent browser** in settings view with split-panel layout, visibility config, and keyboard navigation.
- Added **context-aware "New Agent" button** matching the current agent category.
- Added **simplifier** and **presenter** tool-use agents for scientific code/LaTeX cleanup and Beamer presentations.
- **Main view agent/model buttons** now open settings view tabs directly.
- Added **model dropdown** and **sync/async mode badges** on agent proposals.
- Added **execution status** badges on orchestrator and runs tool.
- Added **live tool timers** with timeout display and **real-time bash output**.
- Added **reject-with-feedback** for bash command approvals.
- Added **manual conversation compaction** for tool-use agents.
- Added **memory tool display** in progress view.
- Added **subagent output capture** for orchestration.
- Added **remote agent tools** shown in agent proposals.
- Added **batched Lean loogle queries**.
- Added **accept_run_files tool** for orchestrator to accept workflow outputs.
- Added **PDF page limit handling** — agents receive guidance instead of errors.
- Added **structured fields** (title, author, year) to the `zotero_search` tool.
- Added **Terms of Service** and **Providers** pages to the documentation site.

### Bug Fixes

- Fixed **context window overflow** during long sessions.
- Fixed **cache invalidation** causing unnecessary re-sends.
- Fixed **thinking model token limits** being too low in tool-use mode.
- Fixed **compaction size** reporting inaccuracy.
- Fixed **auto-scroll** when switching stream tabs.
- Fixed **stream tab delete button** clipped at narrow widths.
- Fixed **agent proposals** racing with model options loading.
- Fixed **agent visibility** not handling new agents correctly.
- Fixed **bash processes** not cleaning up on timeout (Windows included).
- Fixed **background polling** reliability.
- Fixed **path traversal** and **workspace boundary** validation.
- Fixed **Windows path** normalization throughout.
- Fixed **Lean 4** file lookup and syntax highlighting.
- Fixed **agent status icon** not updating after successful retry.
- Fixed **LaTeX diff dropdowns** opening in the wrong direction.
- Fixed **Zotero search** results not displaying correctly.

### Improvements

- Added **tool timeouts** across all tools.
- Optimized **progress view** performance.
- **Migrated agent settings** to the Settings View.
- Removed **deprecated agents** (tex_linter_fix, xml_validator).
- **Restricted tool-use agents** from out-of-workspace filesystem access.
- Updated dependencies.

## [0.35.9] - 2026-02-06

### Features

- Added **Claude Opus 4.6** (`opus46`, `opus46T`).
- Added **model selection UI** in Models tab with provider grouping, deprecation toggles, and tier indicators.
- Added **polish model dropdown** in the model selection section.
- Added **inline provider API key management** in the Models tab.
- Added **unified Dashboard** consolidating history, memory, and profile views with a searchable, collapsible history list.
- Added **diff display** for edit tool in progress view with inline line numbers and file links.
- Added **live tool commands** in progress view, shown immediately before execution completes.
- Task Progress section now **collapsed by default** for a cleaner UI.
- Increased **default session retention** to 2 weeks.
- Added **server compaction** support with summaries shown in progress view.
- Migrated **streaming & endpoint settings** to the Settings View.
- Enabled **1M context window beta** for Claude Opus 4.6.

### Bug Fixes

- Fixed **sign-in timeout** when auth provider fails, and auth errors no longer block unrelated initialization.
- Fixed **agent output** leaking internal reasoning into files.
- Fixed `$` **in replacement strings** being interpreted during edit operations.
- Fixed **GPT-5 token counting** fallback when counting fails.
- Fixed **Windows compatibility** for paths and line endings in graphicspath parsing.
- Fixed **context overflow** in tool-use agents.
- Fixed **token counting accuracy** and inflated history after compaction.
- Fixed **LaTeX diff UI** regression.
- Fixed error message titles not being selectable/copyable.
- Fixed **duplicate media file listing** in progress view.

### Improvements

- More native VS Code look with codicon toolbar buttons across settings and progress views.
- Updated dependencies.

## [0.35.8] - 2026-02-02

### Features

- Added **Kimi K2.5 models** with thinking and temperature support, and **DeepSeek thinking parameter**.
- Added **accurate token counting** for OpenAI Response API.
- Added **syntax highlighting** in bash command approval prompts.

### Bug Fixes

- Fixed token usage stats not displaying for tool-use agents in progress view.
- Fixed display math `\[...\]` inline rendering rule.

### Improvements

- Internal refactoring for improved maintainability.
- Updated dependencies.

## [0.35.7] - 2026-01-24

### Features

- Added **Zotero integration** tools (`zotero_search`, `zotero_export`, `zotero_add`) for literature management.
- Added **ShareLaTeX git support** in the clone command for self-hosted Overleaf instances.
- Added **bib path setting** (`texra.defaultBibPath`) to configure the default bibliography file location.
- Added **apply agents** for implementing review suggestions, and **attach agent outputs** option in follow-up mode.
- Added **bash command approval system** with per-stream YOLO mode bypass. **YOLO mode** is now per-stream with a distinct visual indicator.
- Added **grep offset parameter** for paginating through large search results.
- Progress view improvements: **syntax highlighting** for tool output and bash commands, and **selectable tool use headers**.
- Agent and model dropdowns now **sync between progress view and main webview**.
- **User messages** can now be sent while tools are executing without ending the turn.
- Added **automatic token refresh** for improved session continuity.

### Bug Fixes

- Fixed tool display issues: edit tool not showing deletions, grep error handling for empty results, and Wolfram error messages missing details.
- Fixed progress view rendering: nested scrollbars in code blocks and math causing duplicate text.
- Fixed retry and auth handling: background response reliability and token refresh loops.
- Fixed session persistence: first user message disappearing and stale content when switching agents.
- Fixed diff naming producing incorrect labels when input file contains round numbers.
- Fixed merge agent not respecting multiple outputs setting.
- Fixed OpenAI Responses API not completing background responses.

### Improvements

- Improved tool error recovery suggestions.
- Optimized progress view performance.
- Updated dependencies.

## [0.35.6] - 2026-01-19

### Features

- Added **Orchestrator** tool-use agent for multi-agent workflow coordination with proposal review system.
- Added **Runs tool** for accessing agent execution history.
- Added **Workflow agent proposal** system with frontend UI for reviewing and approving delegated tasks.
- Added **Lean** agent to default tool-use agents with VS Code integration, real-time diagnostics, and dedicated tools.
- Added **LaTeXdiff changed pages only** option for tool edit proposals.
- Added **pasted arXiv URL support** in download source command.
- Added **New button with mode-specific clearing** for workflow/tool-use views.
- Added **always-visible YOLO mode toggle** button in the header.
- Added **literal matching option** to grep tool for fixed string searches.
- Added **reference-agents** folder with example agent definitions.

### Bug Fixes

- Fixed agent/model dropdowns to open upward for better visibility.
- Fixed extension activation error.
- Fixed progress view theming.
- Fixed LaTeX tool detection reliability.
- Fixed empty chat display and stale log content between tabs.
- Fixed chat resume validation to support flat message format.
- Fixed range parameter handling in read_file tool.
- Fixed context window updates during streaming.
- Fixed diff naming to prevent incorrect labels when comparing same-round files.

## [0.35.5] - 2026-01-15

### Features

- Added **Followup Task** feature for workflow continuation directly in the Progress View, with chat mode and support for multiple file merges.
- Added a **Lean Proof** tool-use agent for informal-to-formal Lean 4 verification workflows.
- Added a **Merge Multiple** agent for batch merge operations.
- Added **LaTeXdiff preview** button in tool edit approval dropdown for comparing proposed changes.
- Added expandable error details to retry dialog UI.
- Relay errors are now retryable with clearer error messaging.
- Added setting to control thinking block clearing (`texra.model.enableThinkingClearing`).
- VS Code GitHub login is now hidden behind a config flag.

### Bug Fixes

- Fixed duplicate workflow launches.
- Fixed agent cancellation responsiveness.
- Fixed multiple output filename handling.
- Fixed temp file cleanup.
- Fixed relay error recovery.
- Fixed tooltip and dropdown clipping issues.
- Fixed bash tool error messages to include stdout.
- Fixed queued follow-up messages not being combined.
- Fixed context state display accuracy.

## [0.35.4] - 2026-01-10

### Features

- Added **Memory View** for browsing and managing agent memory entries with delete controls.
- Added **context utilization display** showing percentage of context window used on each API call.
- Added automatic conversation compaction for long sessions.
- Added button to open progress view in a separate editor tab.
- Chat mode is now the default session type with a simplified UI.
- Memory tool is now enabled by default with a toolbar toggle.
- Added diff syntax highlighting in tool output display.
- Added cache token display (read and creation) in usage statistics.
- Token counts now format as millions (M) when >= 100K for readability.
- Model is now informed when users modify or reject suggested edits.

### Bug Fixes

- Fixed canceling rejection by pressing Escape on feedback input.
- Fixed memory list not refreshing after deletion failure.
- Fixed thinking block clearing not triggering properly.
- Fixed LaTeX math delimiters not rendering correctly in markdown output.
- Fixed conversation messages not syncing after tool-use cycles.
- Fixed log content clearing when falling back to default session kind.
- Fixed chat history clearing on follow-up after extension reload.
- Fixed memory checkbox not being clickable.
- Fixed thinking blocks clearing prematurely.
- Fixed agent dropdown not syncing with session toggle.
- Fixed cached tokens not being included in context measurement.

### Improvements

- Improved tool use display to distinguish user feedback from errors.
- Unified header styles across dashboard views.
- Simplified run selector dropdown to show only timestamp.
- Updated dependencies.

## [0.35.3] - 2026-01-05

### Features

- Added monthly spending limits for relay users.

### Bug Fixes

- Improved progress board layout with better log grouping and reduced whitespace.
- Fixed relay authentication expiring during long-running sessions.

## [0.35.2] - 2025-12-30

### Bug Fixes

- Fixed symlink handling in workspace path resolution and file dialogs.
- Fixed OAuth callback handling for web environments.
- Fixed status tooltip clipping.
- Fixed clean auxiliary files button icon.
- Added resuming status styling and changed stopped status to neutral gray.

## [0.35.1] - 2025-12-29

### Features

- Added **Gemini 3 Flash** (`gemini3f`) to the default models list.
- Chat and tool-use agents can now be hosted as remote agents.
- Introduced **premium plans** with access to flagship models for subscribers.
- Added **Researcher Access Program** with complimentary access to budget
  models including GPT-5 Mini and Nano.
- Added access expiration system for researcher access program.

### Bug Fixes

- Fixed LaTeX-style backtick quotes in document name extraction.
- Fixed dropdown option selection not updating visually.
- Fixed cloud icon sizing in agent dropdown.
- Fixed tool name handling in tool definitions.
- Fixed absolute path handling in file location creation.
- Fixed agent and model selection reverting to defaults.
- Fixed missing usage info in OpenAI Responses API streaming.
- Disabled automatic retries by default to give users explicit control.
- Added tooltips to toolbar buttons across all webviews.
- Clarified reference and auxiliary file selector tooltips.
- API Access toggle now visible for all authenticated users.

### Improvements

- Updated core dependencies.

## [0.35.0] - 2025-12-16

### Bug Fixes

- Fixed OpenAI streaming with web search results.
- Fixed Google model response handling.
- Fixed LaTeX replacement rules causing formatting issues.
- Fixed latexdiff output causing compilation errors.
- Fixed model dropdown resetting media selection when changed.
- Fixed stream list not auto-refreshing when status changes.
- API key banner now hides when the model no longer requires a key.

### Improvements

- Updated core dependencies.

## [0.34.10] - 2025-12-13

### Features

- Added **GPT-5.2** (`gpt52`, `gpt52pro`) to the default model list.
- Introduced **flexible user groups** with permission-based access control
  and subscription tiers for remote agents.
- Added a **todo list UI** in the progress view for tool-use agents.
- Added **Research agent** for analytical derivations and scientific research.
- Added **Search agent** to the default tool-use agents for web search workflows.
- Profile view now displays a **multi-output support indicator**.

### Bug Fixes

- Resolved duplicate sign-in messages.
- Fixed profile view agent selection reliability when switching between remote agents.
- Fixed OpenAI streaming missing reasoning items with web search.
- Fixed agent selection when switching session types.

## [0.34.9] - 2025-12-10

### Features

- Added **native web search** support for Anthropic and OpenAI models, with
  real-time search results displayed in the progress view.
- Introduced a new **Web Search** tool-use agent optimized for research queries.
- Added **OpenAI deep research models** (`o3-deep-research`, `o4-mini-deep-research`).
- Updated **DeepSeek models to V3.2** with streaming reasoning support.
- Added **getting started guidance** that appears when opening an empty folder.

### Bug Fixes

- Fixed Windows path handling in progress view stream tabs.
- Agent selection now persists correctly when switching between sessions.
- Remote agents with multiple output variants now group correctly.
- Fixed Anthropic streaming with interleaved thinking and text blocks.
- Fixed figure path resolution for input files in subdirectories.
- Fixed `\input` path compatibility by normalizing leading `./` prefixes.
- User-cancelled requests no longer trigger automatic retries.
- Fixed banner display issues when refreshing the webview.

### Improvements

- Updated core dependencies.

## [0.34.8] - 2025-12-04

### Features

- Added **DeepSeek V3.2 Speciale** (`deepseekT+`) with 163k context.
- Enabled tool calling for DeepSeek thinking models.

### Bug Fixes

- Improved tool detection on Unix-like systems for `latexdiff` and related utilities.

### Improvements

- Updated core dependencies.

## [0.34.7] - 2025-11-30

### Bug Fixes

- Fixed packing and cleaning operations not working correctly.

## [0.34.6] - 2025-11-30

### Features

- Introduced **Remote Agents**, letting you browse and run cloud-hosted agents
  directly from the new Profile view.
- Added **manual retry controls** so you can retry failed API requests on demand.
- Display provider icons in the model dropdown.

### Improvements

- Added **Claude Opus 4.5** (`opus45`, `opus45T`) to the default model catalog.
- Widened agent and model dropdowns and added descriptive tooltips.
- Footer dropdowns now open upward to prevent clipping.
- Stream tab close buttons are always visible.
- File selection lists are now sorted alphabetically.
- History view displays the session kind (workflow vs tool use) for each entry.

### Bug Fixes

- Resolved duplicate agent names appearing in the dropdown.
- The API key banner displays reliably on initial webview load.
- arXiv search queries with multiple terms now return more relevant results.

## [0.34.5] - 2025-11-21

### Bug Fixes

- Fixed support for the Kimi 2 Thinking model so it streams reliably again.

## [0.34.4] - 2025-11-14

### Features

- Added a **Collect references** helper that gathers the BibTeX entries your project cites and calls out anything missing.
- Added **GPT-5.1** (`gpt51`) to the model catalog.

### Improvements

- The progress board now loads conversations faster and keeps stream updates responsive.
- Run reviews feel smoother with persistent run context, clearer timestamps, and a ready input box.
- Workspace cleanup is less disruptive: generated artifacts stick around, TeX files are detected more reliably, and `\input{}` paths stay intact.

### Bug Fixes

- Workflow controls once again behave as expected — resume, restart, and stop actions reliably reflect the state of your run.
- Progress board summaries stay in sync with agent defaults and usage totals.
- Tool calls are steadier across providers, avoiding duplicate uploads and missing workflow outputs.
- Bibliography parsing now handles complex citation files without crashing.

## [0.34.3] - 2025-11-07

### Features

- Added **Clone Overleaf Project** command to initialize a local workspace from an Overleaf project.
- Added **tool edit approvals** from the progress board with a pending approvals queue, unified diffs, and rejection-to-follow-up flow.
- Added **workflow output capture** so orchestrated workflows can reuse generated artifacts.
- Added dedicated **arXiv metadata/search** and **Crossref DOI lookup** tools.
- Added **Kimi K2** thinking variants to the model catalog.

### Improvements

- Expanded the progress board empty state with a shortcut to the Overleaf clone flow.
- Improved Overleaf initialization validation and error reporting.
- Updated Kimi K2 naming and pricing.

### Bug Fixes

- Fixed Google Gemini tool call reliability.
- Fixed arXiv metadata tools returning stale results.
- Fixed progress board errors when reviewing runs.
- Fixed duplicated LaTeX environment tags producing malformed output.
- Fixed tool-use cost tracking and edit approval sync.
- Fixed OpenAI file upload fallback on timeout.

## [0.34.2] - 2025-10-31

### Features

- Redesigned the **Progress Board** with a resizable split layout, persistent instruction panel, and inline follow-up controls.
- Streamlined the **main command view** with toolbar-based file pickers and a radio-group session selector.

### Improvements

- Improved `read_file` tool with line numbers and ranged reads up to 2,000 lines.
- Expanded LaTeX cleanup to handle more HTML entities and legacy equation macros.

### Bug Fixes

- PDFs and images from the `read_file` tool are now returned as proper attachments instead of corrupted text.

## [0.34.1] - 2025-10-24

### Bug Fixes

- Fixed toolbar controls and automatic log scrolling in progress view.
- Fixed Claude Haiku 4.5T thinking mode not working correctly.
- Fixed dropdown menus being cut off at container edges.

### Improvements

- Show inline progress display when polishing instructions.
- Cleaner progress board stream tabs.
- More compact model selection dropdown.
- Updated core dependencies.

## [0.34.0] - 2025-10-19

### Features

- Added an interactive VS Code **walkthrough** that guides first-time users through model setup, file selection, and the progress board.
- Added **Claude Haiku 4.5** (`haiku45T`, `haiku45`) to the model catalog.

### Improvements

- Streamlined custom agent prompt handling with automatic migration of older entries.
- Model picker now waits for options to load so newly enabled models appear reliably.
- Added Magic Polish and microphone recording controls to the progress view follow-up input.
- Updated CoT agent icon for clearer visual distinction.

### Bug Fixes

- Fixed scratchpad exports to reopen the named document when agents generate multiple files.
- Fixed tool-use session migration so saved runs load and resume without errors.
- Improved OpenAI thinking summaries with clearer spacing.
- Fixed workflow outputs disappearing from the progress board when no new files were written.
- Progress board timestamps now show in your local timezone instead of UTC.

## [0.33.10] - 2025-10-10

### Features

- Added **GPT-5 Pro** (`gpt5pro`) to the model catalog.
- Prompt for latexdiff math markup before each run.
- Added `extract_figures` and `extract_tikz_figures` tools for returning referenced images and compiled TikZ PDFs.
- Added ranged reads to `read_file` tool.

### Improvements

- Added one-click **Generate diff** controls with auto-selected comparison commit.
- Refreshed the **Progress Board** with copy buttons, native status styling, and a cleaner layout.
- Updated Progress Board empty state with quick links.

### Bug Fixes

- Fixed agent error logs detaching from the latest run in the Progress Board.
- Fixed background responses generating stray streaming updates.
- Fixed agent runs launching when initialization fails.
- Fixed workflow-only responses showing in the Progress Board.
- Improved LaTeX fenced-block parsing for inline math and `aligned` environments.
- Fixed default agent selection in new workspaces.
- Fixed arXiv downloads leaving files outside their staging folder.

## [0.33.9] - 2025-10-03

### Features

- Added `apply_path` and `download_arxiv_source` tools for patches and arXiv source fetching.
- Default workflow and tool-use pickers now use curated presets.
- Added **Open storage** button in the progress view for inspecting run outputs.
- Added between-round `latexdiff` controls and Texcount mode selection.
- Added **Claude Sonnet 4.5** (`sonnet45`, `sonnet45T`) to the model catalog.

### Bug Fixes

- Fixed Anthropic PDF uploads on follow-up requests.
- Fixed PDF filename handling for nested paths.
- Fixed tool-use session resume so follow-ups, execution state, and multi-output agents restore reliably.
- Respect `.gitignore` rules across `glob`, `grep`, and file listings.
- Fixed custom agent directory initialization and default agent visibility.
- Fixed Google model errors not surfacing clearly.

## [0.33.8] - 2025-09-30

### Features

- Split the agent picker into **workflow and tool-use sessions** with a toggle.
- Updated **Gemini 2.5 Flash** to the September 2025 release.
- Updated **Qwen-Max and Qwen Plus** with new pricing and thinking support.

### Bug Fixes

- Improved scratchpad markdown fallbacks when Pandoc is unavailable.
- Fixed prompt exports not resolving paths correctly.
- Fixed progress view state corruption.
- Fixed history entries not restoring correctly.
- Capped `read_file` tool responses at 400 lines to prevent oversized outputs.
- Redesigned agent selector footer with compact session toggle and per-session dropdowns.
- Trimmed default tool-use agent list to conversational presets.
- Fixed history view toggle state not persisting across versions.
- Fixed stale state resurfacing after failed initialization.
- Fixed model options not rendering reliably on successive updates.

## [0.33.7] - 2025-09-22

### Features

- Added install and re-check actions to the dependency banner.
- Separate tool-use streams in the Progress Board with All / Workflow / Tool Use filters.
- Show tool-use hints in the agent dropdown.
- Added a copy button to each model response entry.
- Persist tool-use sessions across restarts with a resume command.
- Added workspace-aware `glob`, `grep`, and `ls` tools to the default registry.
- Added a `web_fetch` tool for downloading and converting web pages to Markdown.
- Added `read_file`, `write_file`, and `edit_file` tools for workspace editing.
- Added a built-in read-only `ask` agent for safe project inspection.
- Show the active instruction at the top of the Progress Board.
- Allow DeepSeek chat models to call tools.

### Bug Fixes

- Fixed HTML entities in follow-up messages so languages like Chinese render correctly.
- Fixed legacy tool configuration keys breaking after cleanup.
- Fixed LaTeX replacements for beamer column layouts and special characters.
- Fixed empty model response logs showing in the Progress Board.
- Fixed workflow toolbar actions running on tool-use streams.
- Fixed empty user messages causing API errors.
- Fixed tool-use runs not visible when a workflow starts in another stream.
- Fixed agent errors not surfacing in the Progress Board timeline.
- Fixed `.gitignore_global` rules not honored in workspace listings.
- Fixed OpenAI Responses dropping parts of assistant replies.

### Improvements

- Summarize tool-use logs with clearer titles and expandable sections for long outputs.

## [0.33.6] - 2025-09-14

### Features

- Show a banner when required dependencies are missing and check tools before running.
- Added `kimi2` to the model list.
- Clarified output file controls in the webview.

### Bug Fixes

- Fixed Ghostscript detection on Windows and ImageMagick false positive.
- Fixed tool-use agents not appearing in the dropdown when enabled.
- Fixed model API key banner behavior and multi-file toggle labels.
- Fixed file selection notification showing for non-input files.
- Fixed empty thinking logs showing in model reasoning display.

### Improvements

- Updated AI SDK packages.
- Improved file dialog helpers for better cross-platform compatibility.

## [0.33.5] - 2025-09-07

### Features

- Replaced Qwen Max with **Qwen3 Max** for improved reasoning and 256k context.
- Updated **Qwen Plus** with hybrid reasoning and 1M context.
- Updated **Moonshot Kimi** models to K2 0905 preview and added turbo variant.
- Added setting to enable/disable GPT-5 reasoning summaries.
- Added configuration banner for missing agent files with quick setup actions.
- Added visual indicator for agents with multiple output support.
- Replaced "(no key)" with a cleaner symbol in model dropdown.

## [0.33.4] - 2025-09-03

### Features

- Support round-specific reflection prompts and iteration across multiple rounds.
- Highlight missing API keys with provider-specific banner and setup links.
- Added model metadata tooltips showing provider, context window, and cost.

### Bug Fixes

- Fixed output handling to work with any round count.
- Consolidated API key setup alerts into a single banner.
- Fixed unnecessary escape characters in LaTeX references.

## [0.33.3] - 2025-08-29

### Features

- Include `.bbl` files when searching for reference files.
- Guide new users through API key setup with links to provider pages.
- Show persistent "Set API Key" banner until a key is configured.

### Bug Fixes

- Restrict GPT OSS models to OpenRouter only.
- Improved API key detection to check environment variables.

## [0.33.2] - 2025-08-25

### Features

- Added sample project command to help new users get started with a complete example.
- Added chat tool-use agent for interactive document-based conversations.
- Stream model responses separately from reasoning for better visibility into agent thinking.
- Show helpful empty-state placeholder in progress view with quick links.
- Added interactive launch page to documentation site.

### Bug Fixes

- Fixed welcome dialog not displaying properly on first launch.
- Fixed pack and clean operations using wrong task output.
- Fixed placeholder visibility when clearing progress view logs.

## [0.33.1] - 2025-08-22

### Features

- Detect arXiv source file type and handle plain `.tex` downloads without extraction.
- Added descriptive tooltips for Input, Reference, Auxiliary and Media file selectors.
- Show onboarding tooltips on first use with a "Never remind again" option.
- Added real-time streaming display for model reasoning/thinking processes.

### Bug Fixes

- Restrict extension to single workspace folder to prevent initialization issues.
- Fixed welcome dialog flag set before dialog displays.

## [0.33.0] - 2025-08-19

### Features

- Show TeXRA task status in the VS Code status bar.
- Automatically resize large images (> 2000px) for better performance.
- Allow disabling LaTeX formatting and silencing missing `latexindent` warnings.
- Added `texra.maxImageDimension` setting to control the maximum image size.
- Added "New" button in main view to reset all fields.
- Prompt users to install LaTeX Workshop extension with "Never remind again" option.

### Bug Fixes

- Fixed status bar command registration and task cancellation handling.
- Fixed `latexdiff` not finding Perl on Windows with MSYS2.
- Fixed first task being marked as error when progress view loads.
- Fixed DeepSeek and Google model streaming issues.
- Fixed LaTeX Workshop configuration being overwritten.

### Improvements

- Improved streaming stability across model providers.
- Improved LaTeX extraction from agent responses.

## [0.32.10] - 2025-08-13

### Bug Fixes

- Prompt users to open a workspace folder when none is active.

## [0.32.9] - 2025-08-09

### Bug Fixes

- Fixed PDF uploads to OpenAI.

## [0.32.8] - 2025-08-09

### Features

- Enabled model streaming & response APIs by default.

## [0.32.7] - 2025-08-08

### Features

- Added **Claude Opus 4.1** (`opus41`, `opus41T`).
- Added **GPT OSS** 120B and 20B reasoning models (`gptoss`, `gptoss-`).
- Added **GPT-5** family models (`gpt5`, `gpt5-`, `gpt5--`).

### Bug Fixes

- Updated OpenAI, Anthropic, and Gemini SDKs.

## [0.32.6] - 2025-08-03

### Features

- **Follow-up Chat** — continue conversations with tool-use agents directly in the progress view with multi-line input support.
- **Code Syntax Highlighting** — code blocks in progress view now adapt to your VS Code theme.

## [0.32.5] - 2025-07-31

### Features

- Added syntax highlighting for code blocks in the progress view.
- Introduced tool-use agents with support for web search and code execution.
- Added stream sorting option in progress view settings.

### Bug Fixes

- Fixed duplicate agents appearing in the dropdown menu.
- Fixed theme switching for code highlighting.
- Fixed various issues with file list button interactions.

## [0.32.4] - 2025-07-25

### Features

- Right-click on YAML agent files in Explorer to quickly add them to your agent list.
- Improved agent configuration with better file type handling.

### Bug Fixes

- Fixed restoration of agent states when reopening sessions.

## [0.32.3] - 2025-07-20

### Features

- Improved statistics view UI with cleaner rendering.

## [0.32.2] - 2025-07-19

### Bug Fixes

- Fixed missing LaTeX diff message rendering in progress view.

## [0.32.1] - 2025-07-10

### Features

- Default model switched to **Gemini 2.5 Pro**.
- Added **Grok 4** model with extended context window support.

## [0.32.0] - 2025-07-07

### Features

- **Claude Sonnet 4T** (Thinking) model set as default.
- Added **Grok 4 Beta** model with 131k context window.

## [0.31.10] - 2025-07-04

### Features

- Progress view templates for consistent UI.
- Markdown rendering restored with KaTeX math support.
- Diff errors now displayed as helpful tooltips.

## [0.31.9] - 2025-07-01

### Features

- Improved file list display in progress view.
- Missing output files now highlighted with direct links.

## [0.31.8] - 2025-06-28

### Features

- Added diagnostics tool and validation agent.
- KaTeX math rendering in progress view.
- Smoother streaming updates in progress view.

## [0.31.7] - 2025-06-25

### Features

- Added bulk latexdiff-vc runner for comparing multiple file versions.
- New tool-use agent capabilities.

## [0.31.6] - 2025-06-25

### Features

- Live reasoning updates displayed in progress view.
- Improved markdown rendering with better styling.

## [0.31.5] - 2025-06-23

### Features

- Redesigned scratchpad and thinking sections.
- Microphone transcription with ElevenLabs support.

## [0.31.4] - 2025-06-17

### Features

- Settings and history buttons moved to editor title bar.
- Optional audio notification when agent rounds complete.
- Enhanced agent creator with better YAML template support.

## [0.31.3] - 2025-06-15

### Features

- Clipboard image pasting in instruction box with automatic cleanup.
- Added arXiv source processor for research papers.
- New deep research model support.

## [0.31.2] - 2025-06-08

### Features

- Collapsible LaTeX diff sections.
- Automatic detection of TeX tools on all platforms.
- Cleaner error messages throughout the extension.

## [0.31.1] - 2025-06-04

### Features

- Added GitHub Copilot model support.
- Smoother streaming output display.
- Diff view auto-refresh and quick access to compiled outputs.

## [0.31.0] - 2025-06-03

### Features

- Google AI thought summaries displayed in progress board.
- Improved diff editor with smart word wrap.
- Dynamic setting updates without restart.

## [0.30.9] - 2025-05-24

### Features

- Automatic cleanup of output files after housekeeping.
- Simplified log navigation with collapsible sections.
- Unified dropdown interface for tools and auto-extract options.

## [0.30.8] - 2025-05-22

### Features

- Clickable output filenames for quick file access.
- Improved history browser with better action buttons.
- Refined UI spacing and visual consistency.

## [0.30.7] - 2025-05-21

### Features

- File progress tracking and diff visualization in progress view.
- Updated API pricing information for all models.
- Round configuration now available in agent settings.

## [0.30.6] - 2025-05-19

### Features

- Updated SDKs for OpenAI, Anthropic, and Google models.
- Improved error messages and user feedback.

## [0.30.5] - 2025-05-13

### Features

- New command to apply LaTeX replacements to current file.
- Added Moonshot Kimi and Alibaba Qwen model support.
- Configurable LaTeX diff markup options.

## [0.30.2] - 2025-05-06

### Improvements

- Updated Gemini model naming for clarity.

## [0.30.1] - 2025-05-06

### Features

- Updated Gemini 2.5 Pro model configuration.
- Enhanced quick-start documentation.

## [0.30.0] - 2025-05-04

### Features

- Explorer now hides build directories by default.
- Enhanced DeepSeek model support.
- Improved PDF viewer with better tab management.

## [0.29.11] - 2025-05-04

### Features

- Added O4 models support.
- Improved DeepSeek integration with official API and OpenRouter.

## [0.29.10] - 2025-05-04

### Improvements

- Code formatting improvements and stability enhancements.

## [0.29.7] - 2025-05-02

### Bug Fixes

- Fixed progress view display issues.

## [0.29.2] - 2025-04-22

### Features

- Added Gemini-2.5-Flash model support.
- Enhanced Unicode character replacements.

## [0.29.0] - 2025-04-17

### Features

- First public release of TeXRA.
