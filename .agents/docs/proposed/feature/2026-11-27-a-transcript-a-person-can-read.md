# A transcript a person can read

Date: 2026-11-27
Status: proposed (the first seven fixes are built in the PR that adds this
note; the findings under "Open" are not)

Origin: the owner's comments on the desktop app's conversation view over one
afternoon, generalized, and one pass over every kind of run in the golden
store (`src/test-kernel/fixtures/storage/golden-1.0.sql`) rendered in the
real Electron app in both themes. The visual reference the owner named is
Orca (github.com/stablyai/orca), whose transcript rows are flat lines: an
icon, a quiet verb, the target in the reading colour, quiet facts at the end,
one disclosure, no separators and no frame around a row.

## The rules the comments come to

1. **Say a thing once.** A row does not repeat its neighbour, its own header
   or its own icon.
2. **Call a thing what it is.** A command is not an agent, a report from an
   agent is not the person's message, a machine identifier is not a label.
3. **A control sits on what it acts on, and opens it in place.**
4. **What looks clickable acts.** A link or a button that does nothing is a
   defect, however the click was lost.
5. **A list shows what a person can still act on.** What ended and left its
   result elsewhere leaves the list.
6. **Readable in every theme**, drawn from the theme's tokens.
7. **Flat and quiet.** One line a row, secondary text secondary, no frame
   inside a frame.
8. **Ask the person only for what needs them.** A run asks through an
   explicit question, not by putting everything up for review.

## Built

| Rule | Was                                                               | Now                                                         |
| ---- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| 6    | Terminal output all black in a light theme                        | Resolved from the theme tokens inside the rendered tree     |
| 1, 3 | A script's calls as bold rows, then a "Log" band repeating them   | One row a call, each opening its own output in place        |
| 1    | "script Script"; "read_file Read notes.tex"; "plan Plan approved" | The tool's icon and its sentence; the name where no icon is |
| 2    | A child's report drawn as the person's bubble                     | A line received from its sender, linked to the sending run  |
| 1    | A one-line report that opened to the same line                    | A plain line with nothing to open                           |
| 4    | A web link in a message did nothing                               | Opens in the project's browser tab                          |
| 4    | A report's link to a run the session no longer holds              | No link                                                     |
| 5    | A finished command listed under its task like an agent            | Leaves the list when it ends                                |

## Open

Each is an instance of a rule above, seen in the pass and not changed.

- **Rule 2. A command's pane is a conversation pane.** A background command
  opens under the "Agent" tab with an `assistant >` breadcrumb and a
  conversation header (`packages/texra/src/ui/progress/components/ProcessRunContent.ts`,
  `packages/texra/src/ui/progress/components/RunHeader.ts`). It should read as
  a terminal session: the command as the session's first line, its output
  under it on one surface, its exit as the last line, and a terminal icon in
  its tab and its list row. Not verified in the running app: the golden store
  holds no command that is still listed, so this needs a live run.
- **Rule 2. A stopped server reads "Error".** A command a person or its task
  stopped is drawn with the failure mark. A stop is not a failure.
- **Rule 5, 1. Three homes for one agent.** An agent a task started is in the
  task list, in the "N agents in the background" panel above the conversation
  (`packages/texra/src/ui/progress/components/BackgroundTasksPanel.ts`) and in
  its call's row. The panel also says "in the background" of an agent the
  task waited for and that has finished. The panel should hold what is
  running now, and say so.
- **Rule 1. An agent call's card repeats its header.** "Completed
  'golden_child'" opens to `Agent: golden_child`, then the instruction and
  result the child's own conversation shows.
- **Rule 1. A read's card repeats its header.** "Read notes.tex" opens to
  `File: notes.tex`. The link could be the header.
- **Rule 7. Absolute paths.** A call's header shows a path from the
  filesystem root, which wraps to two lines. A path inside the project should
  be shown from the project's root.
- **Rule 6. A terminal keeps the theme it was opened in.** A tool card's
  terminal resolves its theme once
  (`packages/texra/src/ui/progress/components/TerminalOutput.ts`); the
  desktop's terminal pane refreshes on a theme change and this one does not.
- **Rule 2. Old conversations.** A report delivered before the sender was
  recorded has none and is still drawn as the person's message. The sender
  could be read from the run's `followup.queued` rows instead of the log
  payload, which would cover every stored conversation and remove the second
  copy of the fact.
- **Rule 8. Review.** See "Related: asking the person" in
  `.agents/docs/proposed/architecture/2026-11-27-how-a-report-reaches-the-receiving-model.md`.
- **The terminal client.** The pass covered the progress view. The CLI got
  the sender of a received message and nothing else; its script popup and
  tool rows were not re-read against these rules.
