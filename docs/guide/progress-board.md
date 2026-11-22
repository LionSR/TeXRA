<script setup>
import StatusDotLegend from '../.vitepress/components/StatusDotLegend.vue';
import ProgressLogHero from '../.vitepress/components/ProgressLogHero.vue';
import CliHistoryHero from '../.vitepress/components/CliHistoryHero.vue';
</script>

# Tasks view

The Tasks view is TeXRA's live view in VS Code and the desktop app for watching running tasks, inspecting tool calls and reasoning, reviewing generated files, and resuming or forking past tasks.

::: tip CLI
The CLI shows the same streaming reasoning, tool calls, and diffs in `texra chat`. Past tasks are shared across VS Code, desktop, and CLI: browse them with `texra history list` in the terminal or under **Tasks** in VS Code and the desktop app.
:::

::: info Background service
On macOS and Linux, tasks run through the shared background TeXRA service. A task keeps running if you close the window, and another window or `/tasks` in a terminal can follow it. If the service cannot start, the window runs tasks locally instead.
:::

<CliHistoryHero />

<p class="hero-caption">The same tasks from a terminal: one tab-separated row each. <code>texra resume</code> continues a stored task.</p>

## Opening the Tasks view

The Tasks view shares the **TeXRA view** with the New task screen. Select the TeXRA icon in the Secondary Side Bar; the **Tasks** button at the top left lists every task, and **+** starts a new task.

- **Automatic**: Opens automatically when you start a task.
- **Manual**: Run **TeXRA: Show Tasks** (`Ctrl+Alt+P` / `Cmd+Option+P`).
- **Editor tab**: Run **TeXRA: Open Tasks in Editor**, or pick **Open tasks in editor** from the panel's **⋯** menu.

<GuideIntroHero />

<p class="hero-caption">The Tasks view: header and live log on the left, output files on the right.</p>

## Layout overview

The Tasks view has two parts:

1. **Task list**: In the sidebar, **Tasks** opens it as a drawer; in an editor tab it stays docked on the left.
2. **Content area**: Header, conversation log, and generated files for the selected task.

## Task list

Lists stored tasks for the project, including tasks started from the CLI or desktop app.

- **Switching tasks**: Select a task's title to view its logs and status in the Content Area.
- **Renaming or deleting a task**: Each row's <wa-icon library="texra" name="ellipsis"></wa-icon> menu offers **Rename…** and **Delete task**; deleting removes the stored task and its run folder, not just the row. Double-clicking a title also renames it.
- **Metadata**: A row's second line shows the run label (assistant or program), when the task was last active, and the model, with an icon for the kind of task.

## Content area

This area shows the details for the task selected in the Task list.

### Header

The header summarizes and controls the selected task:

- **Task title**: Displays the title of the current task (select it to
  rename). Input files stay on the files panel, not on the task row.
- **Status indicator**: A colored circle shows the current status, with the status word beside it:

<StatusDotLegend />

<p class="hero-caption">The status dot: green while running or completed, yellow while waiting on you or interrupted, gray when ready for your next message or stopped, red on error.</p>

- **Token and cost summary**: A footer below the log shows the task's input and output token counts and its estimated cost, including the agents it started.
- **Header row**: Shows the **Tasks** button, the task's title, status and elapsed time (plus **Revision 2 of 3** for a multi-revision program run), **Stop** while running (cancels the active request immediately where the provider supports it, or stops after the current API call finishes), **New task**, and the **Task actions** menu (`⋯`).
- **Task actions menu (`⋯`)**:
  - **All tasks**:
    - **Rename…**: Change the task title.
    - **Fork**: Branch the conversation into a new task (when the task can be forked), plus a link to each fork already made from it.
    - **Open task folder**: Reveal the run folder in run storage (`executions/<run-id>/`) to inspect generated files, compile logs, mirrored dependencies, and intermediate artifacts.
    - **Export conversation…**: Save the transcript as Markdown, HTML, or PDF.
    - **Copy diagnostics**: Copy the task's title, agent, model, status, task ID, output paths, and compile failures as plain text for bug reports or follow-up tasks.
    - **Delete task**: Remove the task once stopped.
  - **Program runs**:
    - **Run latexdiff on the outputs**: Compare the original input `.tex` file(s) with the generated output `.tex` file(s) using `latexdiff` (read the [LaTeX Diff guide](./latex-diff.md)).
    - **Archive outputs to History**: Copy the run folder (outputs, logs, mirrored dependencies) into a timestamped folder under `History/` (read the [file management guide](./file-management.md)).
    - **Delete output files**: Remove the task's run folder.
  - **Chat tasks**:
    - **Compact conversation**: Summarize earlier turns.
    - **Run again…**: Open the New task form prefilled with the chat's model, instruction, skills, and images to start a fresh task.
  - **Global**: **Open tasks in editor** (or **Back to sidebar**) and **latexdiff…**.
- **After a task ends**: The composer area is replaced by a completion bar offering **Fork** (starts a new task with the conversation up to its last finished turn, leaving the original untouched) and, for interrupted tasks or program runs with saved outputs, **Resume** (continues from saved outputs instead of starting over). Hovering over any of your messages after the first also offers **Fork from here**, which branches the conversation before that message and places the message in the composer.

Reviewed outputs are accepted per file: each row under **Generated files** has
an **Accept** action that copies the edited version into your project.

### Checking a launch

When the assistant proposes a helper agent or program, the card shows the model, instruction, and files. Select **Edit** (`e`) to adjust them before clicking **Approve**; select **Back to …** to return to the calling task while leaving the proposal pending.

### Auto-approval

An approval card's ▾ menu (**Approve all … in this task**) is where you let a
task approve a kind of request on its own: **edits**, **commands** or
**agent work**. Later requests of that kind in the task are approved without
asking. Edits and commands are independent. Agent work also covers the other
two, and turning it off returns all three to asking.

While a grant is on, the task's header shows an amber chip for it
(**Auto: edits**, **Auto: commands**, **Auto: agent work**); its × turns the
grant off. In the narrow sidebar one **Auto** chip stands for all of them,
and its × turns them all off. The composer's **Approval** chip sets the
policy a new task starts with. In the CLI, `/status` lists the same grants
(`auto-approvals: edits, commands`) and `/approval` turns them off.

### Context utilization

A **Context** gauge next to the token count shows how full the model's context window is, as tokens used, the window size and a percentage. When it climbs toward 100%, the conversation may get compacted automatically, or you may want to start a fresh session. An agent can also replace parts of its own context with text it writes (its `context` tool), for example a long tool output it no longer needs; the transcript shows this as **Agent edited its context** with the number of messages replaced and the tokens freed, and still shows the original messages.

### After a program run

To follow up on a finished program run in chat, use **Copy diagnostics** in the
header menu to put the task's output paths and compile failures on the
clipboard, then start a chat with **New task** and paste that text
into the instruction box.

When a run recorded a compile failure, **Fix compile errors** still appears under
**Generated files** and starts a repair chat from those logs.

### Memory

Agents can remember things between sessions. When memory is enabled (toggle in the Settings **Memory** tab), agents keep useful notes about you and your project as Markdown files. The **Memory** tab in Settings, reached with **TeXRA: Open Settings**, opens the two folders they live in. Read the [memory guide](./memory.md) for a full walkthrough.

### Log content

This scrollable area displays the detailed, timestamped logs for the selected agent run.

- **Structure**: Logs are organized into expandable groups (e.g., `Revision 1`). Response cycles are logged within the corresponding revision group. Select the arrow next to a group name to expand or collapse it.
- **Log levels**: Each line carries an icon for its severity. Debug-level lines and their extra detail are only shown when `texra.logger.debugMode` is set to `true` in `<project>/.texra/config.json` or `~/.texra/v1/global-storage/config.json`; TeXRA does not read VS Code settings.
- **Agent thinking**: Model reasoning appears in shaded **Thinking** blocks, so you can spot when the model is exploring ideas.
- **Errors**: Errors are highlighted and often show what went wrong.

<ProgressLogHero />

<p class="hero-caption">The log: each row is color-keyed by severity (green for info/success, yellow for warnings, red for errors), with expandable nested detail and per-task IDs.</p>

The log content is the main source for diagnosing problems and seeing how TeXRA and the models process your requests. Read the [troubleshooting guide](./troubleshooting.md) for more on using logs.
