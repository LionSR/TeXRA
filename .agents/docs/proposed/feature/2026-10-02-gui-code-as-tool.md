---
created: 2026-10-02
status: accepted
---

# The GUI on code-as-tool, plugins and the durable harness

Baseline: `main` at `859f4f4cd3` (after codemode lanes 1–7 and #13633).
Line references point into that tree. "The codemode doc" is
[`2026-10-01-codemode-everywhere.md`](../architecture/2026-10-01-codemode-everywhere.md);
"the harness doc" is
[`2026-10-02-durable-harness.md`](../architecture/2026-10-02-durable-harness.md),
whose lanes are H1–H6.

The owner ruled on 2026-10-02 that this redesign lands before 1.0, and
accepted it the same day with the rule "we should be as clean as possible":
the six questions in §8 are ruled as recommended, and every remaining
choice takes its cleanest option (§8, "Rulings"). The doc stays under
`proposed/` until its lanes land. It is a design only. It covers the three hosts: the VS Code extension and the
Electron desktop, which share the progress view and the settings view, and
the CLI TUI. It does not redesign the desktop's three-column frame, which
the UX roadmap
([`2026-09-26-desktop-and-extension-ux-roadmap.md`](./2026-09-26-desktop-and-extension-ux-roadmap.md))
ruled sound. That roadmap's open items 1 (one noun) and 5 (palette reach)
are folded in here; its other items stand.

Screenshots of today's surfaces, captured with
`packages/desktop/design-harness/shoot.mjs` and the lane-6 evidence run, are
kept beside the PR for review, not in the tree.

## 1. Persona and journeys

**Mara** is a postdoc in mathematical physics. She writes a paper in LaTeX
with a Lean companion file, gives talks from Beamer slides, and referees for
two journals. She lives in VS Code; she opens the desktop app when she wants
the PDF beside the conversation, and uses `texra` in a terminal on the
group's compute server. She pays for her own API key and also has a ChatGPT
subscription. She does not read JavaScript, and she does not want to learn
what a run, a stage or an attempt is. She wants three things from TeXRA:
help that is correct, changes she can check before they land, and no
surprise bills.

Her journeys, in the order she meets them:

| #   | Journey                          | What she needs to know or do                                                                          |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| J1  | First install                    | Connect a model once; know which agents she has; start                                                |
| J2  | First request                    | Type "tighten section 3"; see what it is doing; approve the edit                                      |
| J3  | A long multi-agent run           | "Have three referees review the paper, then fix what they agree on": see progress, find who needs her |
| J4  | Approving a script               | Decide whether to let it start agents, without reading code                                           |
| J5  | A crash and resume               | Laptop sleeps or VS Code reloads mid-run; come back and continue without losing work or paying twice  |
| J6  | Returning days later             | Find "the referee run on chapter 2" and see what it concluded                                         |
| J7  | Forking or handing off (lane H5) | Try a second approach from an earlier point; or start fresh with a summary when the context is long   |
| J8  | Adding a plugin                  | Add Zotero, an MCP server, or a Claude Code plugin from GitHub; see that a run can use it             |
| J9  | Checking cost                    | Know what a task cost, children included, while it runs and after                                     |

## 2. The ideal surface per journey

Rules that hold for every journey:

- **Code is evidence, not interface.** A script is shown by its title, its
  phases and its calls as plain rows. The source is one click away and never
  the first thing on screen.
- **One home per action.** Every action below has exactly one place where it
  is done; other surfaces show status and link there.
- **The task is the unit.** The user-facing noun is "task" for what she
  started and "agent" for what it started. "Run", "session", "stage",
  "attempt", "category" and raw ids leave the copy.
- **Durable means she never has to remember.** Opening the app tells her
  what stopped and offers to continue it.

**J1, first install.** One "Connect a model" card on the first empty screen
(ChatGPT sign-in, or an API key), then the setup assistant, which also picks
the agent team. No separate team dialog, no banner repeating the card.

**J2, first request.** The composer sends; the transcript shows the
assistant's reply and one compact card per tool call; an edit asks with a
diff. Unchanged from today in shape, with the jargon cut.

**J3, a long multi-agent run.** The script's card is the one home of its
children. Collapsed, it is one line with a count of who needs her. Expanded,
it lists phases and calls:

```
▾ Review and fix chapter 2                       3 agents · 1 needs you · $0.84
   Review
     ✓ Referee A   referee · GPT-6.1 Sol · 2m · $0.21   "Lemma 4 needs a bound"   ›
     ● Referee B   referee · Gemini 3.8 · running 1m                             ›
     ! Referee C   wants to run: latexmk -pdf ch2.tex            [Review]        ›
   Fix
     ○ Fixer       not started
   Show code · Log
```

A row opens that agent's conversation. A finished row shows the first line
of the agent's answer, never the delivery envelope. "Skip" on a running row
is renamed "Stop this agent" and moves into the row's menu.

**J4, approving a script.** The request leads with what approving allows and
what is known so far; the code is folded:

```
┃ Start agents for "Review and fix chapter 2"?
┃ Approving lets this script start agents until it ends. Each agent's edits
┃ and commands still ask you.
┃ First agent: referee · GPT-6.1 Sol — "Review chapter 2 as a referee…"
┃ ▸ Show code (14 lines)
┃ [Approve ▾]  Reject   Add a note…
```

The ▾ keeps "Approve all agent work in this task". "Edit as new task" leaves
this card (see the control table).

**J5, crash and resume.** When a project or `texra` opens and the listing
has interrupted tasks, one prompt lists them (harness ruling Q2: `ask` in
all three UIs):

```
┃ 2 tasks stopped when TeXRA closed
┃   Review and fix chapter 2   stopped 3 h ago · 2 of 4 agents done
┃   Polish abstract            stopped 3 h ago
┃ [Resume all]  Choose…  Not now          Always resume: Settings › General
```

A task that cannot continue says why and offers the fix: "Needs the Zotero
plugin, which is off. [Turn on]". Once dismissed, an interrupted task keeps
one Resume button, on its ended line. A pending approval inside an
interrupted task no longer says "Resume the session to answer" with no
button beside it: the card carries the Resume button.

**J6, returning days later.** Tasks are listed by title, newest first,
grouped by status, searchable, and renameable. A finished task opens at its
last answer with the cost and the files it changed. The TUI's `/resume`
lists titles and dates, not ids.

**J7, fork and handoff.** Each of her messages gets "Fork from here": a new
task with the history up to that message, and her message back in the
composer to change. The ended line and the header menu get "Fork" (the whole
conversation) and "Hand off": the same task continues in a fresh context
that starts from a summary she can edit before sending (the harness's
handoff is reset plus that text). A divider in the transcript marks where
the model's view was cut. A forked task shows "Forked from _Polish abstract_" in
its header; the source lists its forks.

**J8, adding a plugin.** One "Plugins" settings page lists everything that
adds tools or agents: TeXRA's domain plugins (LaTeX, Lean, Zotero, arXiv),
installed Claude Code and Codex plugins, and MCP servers. Each row shows
what it adds, whether it is on, and whether it is trusted, with one switch.
"Add plugin" takes a GitHub URL or a folder. A task's header shows which
plugins it can use; a tool card shows which plugin a tool came from.

```
Plugins                                                    [Add plugin]
  LaTeX tools        built in · 6 tools                          ● on
  Zotero             built in · 3 tools · needs Zotero running   ○ off
  lean-mathlib       Claude Code plugin · 2 skills, 1 MCP server  ● on  trusted v1.2
  arxiv-mcp          MCP server (~/.texra/mcp.json) · 4 tools    used by: assistant
```

**J9, cost.** The footer shows the task's total, its agents included, with
the task's own share on hover. The script card shows its agents' total,
grandchildren included. The TUI status line shows the task total live, and
`/status` breaks it down.

## 3. Today vs ideal, ranked by user impact

Ranked by how often Mara hits it times what she loses.

1. **A crash leaves work stranded with three different Resume buttons and
   no prompt.** Nothing auto-resumes or asks (harness doc, "The three code
   questions"). Resume has three homes: the ended line
   (`BaseRunContent.ts:86-99`), the run row (`RunTab.ts:280-292`) and the
   workflow menu item "Resume from saved outputs" (`constants.ts:84-90`).
   An approval inside an interrupted task reads "Resume the session to
   answer." (`BaseRequestPanel.ts:63-67`), and in the lane-6 capture the
   only Resume is at the bottom of the page. In the TUI an interrupted run
   shows only a `· Resume` marker in the Tab list (`SubagentList.tsx:155`).
2. **A script reads as code and plumbing.** The TUI prints the `agent`
   card's output raw: `<subagent-result id=… status="completed">…`
   (`toolRowSections.ts:634` builds the agent sections without
   `carriesOutput`, so `toolRenderers.tsx:356-357` paints the output). A
   child row's line carries the delivery wrapper "Parent user request
   (constraint context only): …" (lane-6 `script-running-wide.png`). Facts
   say "attempt 2" (`scriptStage.ts:79`, `:211`). The TUI script row is
   titled by its source text. Under the stage, "Call details" repeats every
   call as a raw card (`TaskGroupList.ts:476-504`).
3. **Cost is understated.** The footer reads `run.usage`
   (`BaseRunContent.ts:115-120`), which is the run's own model calls only,
   though `runTreeUsage` (`sessionView.ts:487`) exists and the VS Code
   status bar uses it. The lane-6 capture shows `$0.000` after two agents
   ran. The script total adds direct children only (`scriptStage.ts:333-338`).
   The TUI status line has no cost at all; the session cost appears only in
   the exit summary (`resumeHint.ts:76-98`).
4. **A script's agents appear in three places.** The script stage, the
   desktop Subagents pane (`subagentsPane.ts:19-57`, which #13624's
   `dispatchedChildren` filter did not reach), and the rollup counts. The
   dispatch card and the stage disagree on the noun ("background task" vs
   "agent").
5. **Plugins have two homes and MCP has none.** Tool plugins switch on
   under Tools (`ToolCard.ts:264-327`); Claude Code and Codex plugins
   install under Agents › Skills (`SkillsTab.ts:131-229`) with a trust
   modal; user MCP servers live in `~/.texra/mcp.json` with no UI in any
   host (`mcpConfig.ts:1-20`). The TUI has no plugin command; only the
   `texra plugin` verbs (`commands/plugin.ts`). No surface shows which
   plugins a task can use, though every step records it
   (`tools.offered.plugin`, `offeredTools.ts:29-31`).
6. **Returning is hard.** Titles are the AI description or the agent name
   ("review", "search"), with no rename. The TUI `/resume` labels entries
   by raw id (`ResumeListForm.tsx:50-52`) and clears the visible
   transcript when it adopts a run (`chatSessionController.ts:523-620`).
7. **There is no fork or handoff,** and "Edit as new task" has three homes
   with two meanings: the ended line (`BaseRunContent.ts:100-111`), the
   delegation row (`toolFormatters.ts:155-163`), and the proposal card,
   where it is the `setup` decision (`ProposalRequestPanel.ts:79-196`). All
   of them drop the history.
8. **First install asks for a credential in about six places** (welcome
   webview, welcome card, API-key banner, walkthrough, setup quick pick,
   settings; `welcomeView.ts:117-140`, `OnboardingWelcomeCard.ts:284-356`,
   `ApiKeyBanner.ts:33-65`), and the desktop asks for the team before the
   credential (`desktopOnboarding.ts:144-233`), then the setup assistant
   picks a team again.
9. **Approval scope is set in three places with three scopes:** the header
   "Auto:" switches (`autoApproveSwitches.ts:69-113`), the composer's
   Approval chip (`composerChipMenus.ts:192-222`) and each card's ▾ grant.
   The TUI `/approval` mixes persistent policy, per-run bypass and goal in
   one list (`ApprovalPolicyForm.tsx:55-69`).
10. **Insider copy.** Raw run ids in tooltips (`RunTab.ts:41-73`), the
    outcome question ("Agent run <id> for '…'", `agentChild.ts:185`),
    "Round 2 · 3 tool calls" (`RunHeader.ts:482-502`), "Category: …",
    `/ps` and `/send <id-prefix>` (`sessionCommands.ts:157-224`).

## 4. Information architecture across the three hosts

The rule from the 2026-09-03 ruling stands: one view state, three
renderers. Every fact below is read from `SessionView` or a model in
`src/ui/`; a host decides only how it looks.

| Concept              | Shared model (one owner)                                                                                          | Extension / desktop                   | TUI                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------- |
| Task list and titles | `SessionView.runs`, `run.description` (user title wins, §6)                                                       | drawer / desktop rail                 | Tab list; `/resume` picker          |
| Script card          | `scriptStages` (`src/ui/transcript/scriptStage.ts`), gains summary line, tree cost                                | `<script-stage>` inline               | transcript row + Ctrl-O popup       |
| Agent result         | `toolRowSections` agent builder carries a summary of `run.report`                                                 | first line on the row                 | first line; full text in Ctrl-T     |
| Requests             | `PermissionPayload`, plus a `toolOutcome` kind (§6)                                                               | one request card                      | `ConfirmCard`                       |
| Open-time prompt     | the listing's interrupted roots and their blocked reasons (harness gap 2)                                         | banner above the composer             | notice above the input, `y`/`c`/`n` |
| Cost                 | `runTreeUsage` for totals; per-run `usage` for the hover share                                                    | footer; script card                   | status line; `/status`              |
| Fork, reset, handoff | `context.edit` rows and `run.start.origin` (harness D2, D3)                                                       | message menu; header menu; ended line | `/fork`, `/handoff`, `/clear`       |
| Plugins              | the plugin catalog (`pluginManifest.ts`, installed plugins, `mcp.json`) as one row list; `tools.offered` per step | Settings › Plugins; header chip       | `/plugins`                          |
| Copy                 | `src/ui/copy/*`                                                                                                   | —                                     | —                                   |

Host-specific and staying so: the desktop rail, workbench tabs, palette,
dock badge and notifications; VS Code's diff tabs, status bar and
walkthrough; the TUI's scrollback, Ctrl-O and Ctrl-T readers and slash
commands. The TUI keeps its no-alternate-screen rule; nothing here needs a
fullscreen mode.

## 5. Control mapping

Every control that moves or goes. "Cut" means the action is gone with the
reason given; nothing is dropped silently.

| Control today                                                                                  | Where (file:line)                                                                                                 | New home or cut                                                                                      | Reason                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Resume, ended line                                                                             | `BaseRunContent.ts:86-99`                                                                                         | stays: the one Resume                                                                                | the home                                                                |
| Resume, run row                                                                                | `RunTab.ts:280-292`                                                                                               | row shows "Stopped" status; click opens the task                                                     | one home; the open-time prompt covers bulk resume                       |
| "Resume from saved outputs" (workflow menu)                                                    | `constants.ts:84-90`                                                                                              | ended-line Resume                                                                                    | same action, third home                                                 |
| TUI `· Resume` marker + Enter in Tab list                                                      | `SubagentList.tsx:155`                                                                                            | open-time notice; Enter on a stopped row still resumes                                               | the notice is the discoverable home                                     |
| "Resume the session to answer." text on a card                                                 | `BaseRequestPanel.ts:63-67`                                                                                       | Resume button on the card                                                                            | the action belongs where the question is                                |
| "Edit as new task", ended line                                                                 | `BaseRunContent.ts:100-111`                                                                                       | "Fork" only (keeps history); no "New task from this"                                                 | fork is what users meant; a prefill without history is a cut (ruling 7) |
| "Edit as new task", delegation row                                                             | `toolFormatters.ts:155-163`                                                                                       | cut                                                                                                  | a third home; the child's own task has Fork                             |
| "Edit as new task", proposal card (`setup`)                                                    | `ProposalRequestPanel.ts:79-196`                                                                                  | renamed "Change and start myself"                                                                    | different action under the same label                                   |
| Script request: "Source:" first, "Calls so far"                                                | `ProposalRequestPanel.ts:207-243`                                                                                 | consequence line first; code folded under "Show code"                                                | J4                                                                      |
| Script row "Skip"                                                                              | `ScriptStage.ts:225-264`                                                                                          | "Stop this agent" in the row menu                                                                    | it is a stop; "Skip" clashes with the card's decline                    |
| "Call details" under a stage                                                                   | `TaskGroupList.ts:476-504`                                                                                        | "Log" link inside the expanded script card                                                           | repeats the rows in raw form                                            |
| Facts "attempt N"                                                                              | `scriptStage.ts:211`                                                                                              | "retried" only when N > 1                                                                            | jargon                                                                  |
| Desktop Subagents pane and header button                                                       | `subagentsPane.ts:19-57`; `desktopShell.ts:270-305`                                                               | cut; the script card and the rail tree cover it                                                      | third copy of the children (owner Q2)                                   |
| Dispatch card "Dispatched N background tasks"                                                  | `BackgroundTasksPanel.ts:280-409`                                                                                 | stays for detached agents, renamed "N agents working in the background"                              | one noun                                                                |
| Header "Auto:" switches                                                                        | `autoApproveSwitches.ts:69-113`                                                                                   | read-only grant chip with revoke; granting stays on the card ▾                                       | one home to grant (the card), one to see and revoke (ruling 9)          |
| Composer Approval chip                                                                         | `composerChipMenus.ts:192-222`                                                                                    | stays: the task-start policy                                                                         | different scope (before the task)                                       |
| TUI `/approval` bypass and goal rows                                                           | `ApprovalPolicyForm.tsx:55-69`                                                                                    | `/approval` keeps the policy only; bypasses are granted with `a` on the card and listed in `/status` | three scopes in one list                                                |
| Footer cost (own run only)                                                                     | `UsagePanel.ts:263-282`                                                                                           | task total via `runTreeUsage`; own share on hover                                                    | understated                                                             |
| TUI exit-only "Session cost"                                                                   | `resumeHint.ts:76-98`                                                                                             | stays at exit; also live in the status line                                                          | J9                                                                      |
| VS Code status bar raw `$` tooltip                                                             | `extension.ts:581-615`                                                                                            | `usageCostLabel`, same as the footer                                                                 | subscription runs show a wrong `$`                                      |
| Tools › Integrations plugin switches                                                           | `ToolCard.ts:264-327`                                                                                             | Settings › Plugins                                                                                   | one plugin page                                                         |
| Agents › Skills › Plugins (install, review, update, remove)                                    | `SkillsTab.ts:131-229`                                                                                            | Settings › Plugins                                                                                   | plugins ship more than skills                                           |
| `~/.texra/mcp.json` (no UI)                                                                    | `mcpConfig.ts:1-20`                                                                                               | listed on Settings › Plugins with "Open file"                                                        | visible, still edited as the file (no new format)                       |
| TUI `/config › Tools`                                                                          | `ToolsListForm.tsx:63-100`                                                                                        | `/plugins`                                                                                           | one home in the TUI                                                     |
| Welcome webview, welcome card, API-key banner, setup quick pick                                | `welcomeView.ts:117-140`; `OnboardingWelcomeCard.ts`; `ApiKeyBanner.ts:33-65`; `setupAssistantCommand.ts:107-113` | one "Connect a model" card; the banner shows only after a credential stops working                   | six prompts for one fact                                                |
| Desktop team dialog and "Choose Agent Team" (Help menu)                                        | `desktopOnboarding.ts:144-233`; `catalog.ts:309`                                                                  | the setup assistant picks the team; "Agent team" lives in Settings › Agents                          | team chosen twice                                                       |
| TUI `/resume` id labels                                                                        | `ResumeListForm.tsx:50-52`                                                                                        | title, date, status                                                                                  | ids are not findable                                                    |
| TUI `/ps`                                                                                      | `sessionCommands.ts:157-184`                                                                                      | cut; Tab list shows the same with titles                                                             | duplicate with raw ids (ruling 8)                                       |
| TUI `/send <id-prefix>`                                                                        | `sessionCommands.ts:188-224`                                                                                      | cut; focus the agent (Tab or Alt+N) and type                                                         | duplicate, needs ids (ruling 8)                                         |
| TUI `/clear`                                                                                   | `registerBuiltins.tsx:396`                                                                                        | stays as "start a new task"; `/reset` is the harness reset of this task                              | different actions; name both                                            |
| Header "Round 2 · 3 tool calls" chip                                                           | `RunHeader.ts:482-502`                                                                                            | workflow tasks only, as "Pass 2 of 3"                                                                | loop jargon on tool-use tasks                                           |
| Run-row tooltip raw run id; "Copy run context"                                                 | `RunTab.ts:41-73`; `RunHeader.ts:239-252`                                                                         | id leaves the tooltip; "Copy run context" moves to the header menu's "Copy diagnostics"              | ids are for bug reports                                                 |
| Rail one-click × delete                                                                        | `RunTab.ts:295-312`                                                                                               | the delete that asks (#13148)                                                                        | consistency with the extension                                          |
| Outcome question as a generic userQuestion with "Run again / Skip" radios and a "Skip" decline | `toolUseDispatch.ts:744-794`; `agentChild.ts:185-196`                                                             | its own card: "Did _X_ finish before TeXRA stopped? [Run again] [Skip it]"                           | two "Skip"s on one card; raw id                                         |

## 6. What the model and harness must expose

**Must reach the freeze list now.** Each is an unreleased shape, so under
the codemode doc's "the freeze waits" ruling it lands in its version-1
shape with no upcaster, ideally in H2's PR.

| #    | Row change                                                                                                                                                      | Why the GUI needs it                                                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G-F1 | `context.edit` (harness D2) keeps today's compaction trigger beside `cause`: `trigger: 'context-limit' \| 'context-window' \| 'model-switch' \| 'user' \| null` | D2's `cause: 'compaction'` drops the three causes `model.compaction` has today (`runLedgerEvent.ts:285`), and none records that the user asked (`/compact`). The divider must say "You compacted" vs "Compacted: context was full" vs "Model switched" from the row, not guess |
| G-F2 | `run.description` gains `by: 'model' \| 'user'`; the fold keeps the newest user title over later model ones                                                     | J6 rename. Today the row is "the AI-generated summary" only (`sessionEvent.ts:340`); a user title on the same row with no author would be overwritten by the next model summary                                                                                                |
| G-F3 | A `toolOutcome` arm of `PermissionPayload`: `{ toolName, title, childRunId: RunId \| null }`, decided `retry \| skip`                                           | Today the outcome question is a `userQuestion` whose text embeds a raw run id (`agentChild.ts:185`). A typed arm lets every host draw one card and lets the script stage say "Wants a decision: did Referee B finish?" without parsing prose                                   |

**Already present; the GUI reads them as they are:** the contributing plugin
and revision per offered tool (`offeredTools.ts:29-31`); usage priced at
write (`runLedgerEvent.ts:183-193`), so an old task's cost does not drift
with the pricing table; the launching card (`run.start.parentCard`,
`sessionEvent.ts:266-269`); the script `title` and `phase` on
`script.call`; fork origin (D3) and owned-child `callId` (D4).

**Projections, not rows** (no freeze impact):

- The listing's interrupted roots, each with a structured blocked reason
  `{ kind: 'agentMissing' | 'pluginOff' | 'pluginUntrusted', name }`
  (harness D5 puts the reason in the projection; the GUI needs it typed,
  not as a sentence, to offer "Turn on").
- Fork points: per conversation turn, the settled ledger position the fork
  would cut at, or none (harness ruling Q4 refuses others). The menu item
  is shown only where a point exists; the renderer never computes one.
- The tree cost per run (`runTreeUsage`), folded once, so the script card,
  footer and TUI read one number.
- A one-line summary of an `agent` call's result from `run.report`, built
  by the agent section builder, so no host shows the envelope.

## 7. Lanes

| Lane | Work                                                                                                                                                                                                                               | Size | Depends on                                                      | Freeze |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------- | ------ |
| G1   | Rows G-F1 to G-F3, in H2's change set; golden store regenerated once with H2                                                                                                                                                       | S    | H2                                                              | before |
| G2   | The script card: summary line, phases, agent result summary (TUI raw XML gone), "Stop this agent", "Log" in place of "Call details", folded-code script request, `toolOutcome` card in three hosts; cut the desktop Subagents pane | M    | G1 (outcome card only)                                          | no     |
| G3   | Cost: tree total in the footer, script card, TUI status line and `/status`; status-bar tooltip through `usageCostLabel`                                                                                                            | S    | none                                                            | no     |
| G4   | Open-time prompt in three hosts with blocked reasons and their fixes; one Resume; Resume on an interrupted request card; `/resume` by title; rename                                                                                | M    | H5 (auto-continue), H1 (resume through the parent), G1 (rename) | no     |
| G5   | Fork from a message, Fork, Hand off and Reset in three hosts; "Forked from" header; "Edit as new task" mapped per §5; TUI `/fork`, `/handoff`, `/reset`                                                                            | M    | H5, H2                                                          | no     |
| G6   | Settings › Plugins and TUI `/plugins` over one row list; MCP rows from `mcp.json`; header plugin chip from `tools.offered`; tool-card provenance; one credential card; approval scope cleanup; copy pass (nouns, ids, jargon)      | M–L  | none; the blocked-reason fix action waits for H5                | no     |

G1 is landing inside lane H2's PR, not as a PR of its own, and is the only
lane on the freeze's path. G3 and G6 can start today; G2 can start today
except its outcome card. G4 and G5 follow H5. None needs H3, H4 or H6; G4's resume test joins H6's crash suite as one more
assertion ("the open-time listing names the interrupted root"), not a new
suite.

Each lane ends in an E2E artifact: a design-harness capture for the
progress view and a PTY capture for the TUI, diffed in the PR.

## 8. Owner questions and rulings

### Rulings (owner, 2026-10-02)

The owner ruled "we should be as clean as possible". Questions 1–6 below
are accepted as recommended:

1. GQ1: the script source is folded.
2. GQ2: the desktop Subagents pane is cut.
3. GQ3: fork only at the user's messages and at the end of a task.
4. GQ4: "task" and "agent" are the only nouns.
5. GQ5: the open-time prompt is a non-blocking notice.
6. GQ6: MCP is read-only on the Plugins page, plus "Open mcp.json".

Every other open choice takes its cleanest option:

7. The ended line gets "Fork" only. There is no "New task from this"; a
   prefill without history is a second way to start a task that the
   composer already is.
8. TUI `/ps` and `/send` are cut.
9. The header "Auto:" switches become a read-only grant chip with revoke.

Each cut is listed in the control table (§5) with its reason.

### Questions as asked

1. **Script source in the approval request: folded or open?** Folded
   behind "Show code", with the consequence line and the first agent call
   on top. Approving grants only `agent` calls, and every nested edit and
   command still asks, so the code is not what keeps her safe; reading it
   is optional. _Recommend folded._
2. **The desktop Subagents pane: cut or filter?** Cut. After #13624 a
   script's agents live on its card, detached agents on the dispatch card,
   and the rail tree navigates; the pane is a third copy that already
   drifted (it never got the `dispatchedChildren` filter). _Recommend cut._
3. **Fork granularity.** "Fork from here" on each of the user's messages
   (the new task holds the history before it, and the message returns to
   the composer), plus "Fork" of the whole task at its end. Both are
   settled positions under ruling Q4. Forking from inside a turn is not
   offered. _Recommend both, nothing finer._
4. **One noun.** "Task" for what the user started, "agent" for what it
   started; "run" and "session" leave all copy, including the TUI's
   "Resume this session with" hint and `texra resume`'s help (the command
   name stays). _Recommend yes._
5. **The open-time prompt: blocking or not?** A non-blocking notice above
   the composer; she can type a new request without answering, and "Not
   now" hides it until the next open. "Always resume" sets the `auto`
   policy. _Recommend non-blocking._
6. **MCP servers in the Plugins page: read-only for 1.0?** List them with
   what they add and which agents use them, and "Open mcp.json"; no
   in-app editor. The owner rule is to consume `.mcp.json` as it is, and
   an editor would be a second writer of that file. _Recommend read-only._

## Verified

- Started from `origin/main` at `859f4f4cd3`.
- Read the codemode doc (summary, surface, approvals, resume, plugin fit,
  parity inventory, rulings) and the harness doc on
  `origin/docs/durable-harness` in full.
- Read `src/ui/transcript/scriptStage.ts`, the `run.start`,
  `run.description`, request and ledger arms in `sessionEvent.ts`,
  `offeredTools.ts`, `ModelCompactionPayloadSchema` and
  `runTreeUsage`; spot-checked the cited lines in `BaseRunContent.ts`,
  `RunTab.ts`, `constants.ts`, `toolFormatters.ts`,
  `ProposalRequestPanel.ts`, `ResumeListForm.tsx` and `subagentsPane.ts`.
  The other anchors come from four read-only inventories of the progress
  view, settings, desktop shell and TUI over the same tree.
- Captured 16 design-harness scenes and reviewed the lane-6 script
  captures and TUI frames.
- Read pi v1.0.0 (`a13d35a74`) for `/tree`, `/fork`, `/clone` and its
  codemode renderer, for ideas only.
- Not run: any live model, any suite.
