---
created: 2026-10-02
status: implemented
---

# The GUI on code-as-tool, plugins and the durable harness

The owner ruled on 2026-10-02 that this redesign lands before 1.0 and
accepted it the same day with the rule "we should be as clean as possible".
Its lanes landed: G1 inside lane H2's change set, G2 #13640, G3 #13636, G4 #13659, G5 #13661, G6
#13648, #13647 and #13645, plus the residue pass #13675. It covers the three
hosts: the VS Code extension and the Electron desktop, which share the
progress view and the settings view, and the CLI TUI. It does not redesign
the desktop's three-column frame; the open UX work is in the
[UX roadmap](../../proposed/feature/2026-09-26-desktop-and-extension-ux-roadmap.md).

Two later owner rulings narrow it:

- 2026-10-06: the "Run again / Skip it" outcome card is removed entirely.
  After an interruption the model decides, even under bypass (#13827).
- 2026-10-22: Hand off and Reset go from every host, harness `run.reset`
  included (removal in #14232). Fork, compaction and `/clear` cover the need.

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

| #   | Journey                | What she needs to know or do                                                                          |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| J1  | First install          | Connect a model once; know which agents she has; start                                                |
| J2  | First request          | Type "tighten section 3"; see what it is doing; approve the edit                                      |
| J3  | A long multi-agent run | "Have three referees review the paper, then fix what they agree on": see progress, find who needs her |
| J4  | Approving a script     | Decide whether to let it start agents, without reading code                                           |
| J5  | A crash and resume     | Laptop sleeps or VS Code reloads mid-run; come back and continue without losing work or paying twice  |
| J6  | Returning days later   | Find "the referee run on chapter 2" and see what it concluded                                         |
| J7  | Forking                | Try a second approach from an earlier point                                                           |
| J8  | Adding a plugin        | Add Zotero, an MCP server, or a Claude Code plugin from GitHub; see that a run can use it             |
| J9  | Checking cost          | Know what a task cost, children included, while it runs and after                                     |

## 2. The surface per journey

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
┃ Approving lets this script start agents until it ends. Their edits and
┃ commands follow your approval settings.
┃ First agent: referee · GPT-6.1 Sol — "Review chapter 2 as a referee…"
┃ ▸ Show code (14 lines)
┃ [Approve ▾]  Reject   Add a note…
```

The ▾ keeps "Approve all agent work in this task". On a `setup` proposal the
card's own-start action is "Change and start myself".

**J5, crash and resume.** When a project or `texra` opens and the listing
has interrupted tasks, one prompt lists them (the `texra.resumeOnOpen` setting chooses between
asking and resuming):

```
┃ 2 tasks were interrupted
┃   Review and fix chapter 2   2 of 4 agents done
┃   Polish abstract
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

**J7, fork.** Each of her messages gets "Fork from here": a new task with
the history up to that message, and her message back in the composer to
change. The ended line and the header menu get "Fork" (the whole
conversation). A forked task shows "Forked from _Polish abstract_" in its
header; the source lists its forks. (Hand off was built here; the owner ruled
it out on 2026-10-22, removal in #14232.)

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

## 3. Information architecture across the three hosts

The rule from the 2026-09-03 ruling stands: one view state, three
renderers. Every fact below is read from `SessionView` or a shared model; a
host decides only how it looks.

| Concept              | Shared model (one owner)                                                                                            | Extension / desktop                   | TUI                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------- |
| Task list and titles | `SessionView.runs`; `run.description` carries `by: 'model' \| 'user'`, and the newest user title wins               | drawer / desktop rail                 | Tab list; `/resume` picker      |
| Script card          | `scriptStages` (`packages/harness/src/shared/transcript/scriptStage.ts`), with a summary line and the tree cost     | `<script-stage>` inline               | transcript row + Ctrl-O popup   |
| Agent result         | the `toolRowSections` agent builder carries a summary of `run.report`                                               | first line on the row                 | first line; full text in Ctrl-T |
| Requests             | `PermissionPayload`                                                                                                 | one request card                      | `ConfirmCard`                   |
| Open-time prompt     | the listing's interrupted roots and their blocked reasons                                                           | notice above the composer             | notice above the input          |
| Cost                 | `treeUsage` on each run view for totals; per-run `usage` for the hover share                                        | footer; script card                   | status line; `/status`          |
| Fork                 | `context.edit` rows and `run.start.provenance` (`kind: 'fork'`)                                                     | message menu; header menu; ended line | `/fork`, `/clear`               |
| Plugins              | the plugin catalog (`packages/harness/src/common/plugins/`, `mcp.json`) as one row list; the offered tools per step | Settings › Plugins; header chip       | `/plugins`                      |
| Copy                 | `packages/texra/src/ui/copy/*`                                                                                      | —                                     | —                               |

Host-specific and staying so: the desktop rail, workbench tabs, palette,
dock badge and notifications; VS Code's diff tabs, status bar and
walkthrough; the TUI's scrollback, Ctrl-O and Ctrl-T readers and slash
commands. The TUI keeps its no-alternate-screen rule; nothing here needs a
fullscreen mode.

## 4. Cuts and moves

Each control that moved or went, with its reason, so none is re-added
without one:

- Resume has one home, the ended line. The run row shows "Stopped" and opens
  the task; "Resume from saved outputs" and the "Resume the session to
  answer" text are gone, and an interrupted request card carries the Resume
  button. The open-time notice covers bulk resume.
- "Edit as new task" is gone from the ended line and the delegation row:
  Fork keeps the history, and a prefill without history would be a second
  way to start a task (ruling 7). On a `setup` proposal it is renamed
  "Change and start myself", a different action.
- The script request leads with the consequence line; the code is folded
  under "Show code". A script row's "Skip" is "Stop this agent" in the row
  menu. "Call details" became a "Log" link. "attempt N" shows as "retried".
- The desktop Subagents pane is cut: the script card and the rail tree
  cover it (GQ2). The dispatch card stays for detached agents, under one
  noun.
- The header "Auto:" switches became a read-only grant chip with revoke;
  granting stays on the card's ▾ (ruling 9). The composer Approval chip
  stays: it sets the policy before the task starts. TUI `/approval` keeps
  the policy only.
- Cost: the footer, script card and TUI status line show the task total,
  agents included; the VS Code status bar uses the same label.
- Plugins have one page, Settings › Plugins (TUI `/plugins`), replacing the
  Tools switches, the Agents › Skills plugin rows and the TUI's
  `/config › Tools`. MCP servers are listed read-only with "Open mcp.json"
  (GQ6).
- First install has one "Connect a model" card; the banner shows only after
  a credential stops working. The desktop team dialog and "Choose Agent
  Team" are gone: the setup assistant picks the team, and "Agent team"
  lives in Settings › Agents.
- TUI `/resume` lists titles, dates and status, not ids. `/ps` and `/send`
  are cut (ruling 8). `/clear` starts a new task.
- Raw run ids leave tooltips; "Copy run context" became the header menu's
  "Copy diagnostics". The header's round chip shows "Pass N of M" on
  workflow tasks only.
- The rail's one-click delete asks first, as in the extension.

## 5. Owner questions and rulings

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

Each cut is listed in §4 with its reason.

### Questions as asked

1. **Script source in the approval request: folded or open?** Folded
   behind "Show code", with the consequence line and the first agent call
   on top. Approving grants only `agent` calls, and every nested edit and
   command follows the approval settings, so the code is not what keeps her safe; reading it
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
