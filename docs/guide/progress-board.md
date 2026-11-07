<script setup>
import StreamHeaderActions from '../.vitepress/components/StreamHeaderActions.vue';
import StatusDotLegend from '../.vitepress/components/StatusDotLegend.vue';
import ProgressLogHero from '../.vitepress/components/ProgressLogHero.vue';
import CliHistoryHero from '../.vitepress/components/CliHistoryHero.vue';
</script>

# ProgressBoard

The ProgressBoard is TeXRA's live view in VS Code for watching running tasks, inspecting tool calls and reasoning, reviewing generated files, and resuming or forking past runs.

::: tip CLI
The ProgressBoard is the VS Code extension's live view. The CLI shows the same
streaming reasoning, tool calls, and diffs in its `texra chat` terminal UI. Past
tasks are shared across surfaces. Browse them with `texra history list` in the terminal, or with the **Tasks**
button of the TeXRA view in VS Code.
:::

::: info Background service
On macOS and Linux, a VS Code window runs its tasks in the background TeXRA
service, the same one `texra chat` uses. A task keeps running when its window
closes, and another window, or `/tasks` in a terminal, can follow it. The
window's editor still serves those tasks: diagnostics, inline criticism,
opening a PDF and the editable diff of a proposed edit. If the service cannot
start, the window runs its tasks itself and says so once.
:::

<CliHistoryHero />

<p class="hero-caption">The board's tasks, from a terminal: one tab-separated row each. <code>texra resume</code> picks a stored task back up.</p>

## Opening the ProgressBoard

The ProgressBoard shares the **TeXRA view** with the New task screen. Select the TeXRA icon in the Secondary Side Bar; the **Tasks** button at the top left of the panel lists every task, and **+** starts a new task.

- **Automatic**: It usually opens when you execute an agent.
- **Manual**: Open it from the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) with **TeXRA: Show Tasks**, or press `Ctrl+Alt+P` (`Cmd+Option+P` on macOS). From the New task screen this opens the newest task.
- **Editor tab**: Run **TeXRA: Open Tasks in Editor**, or pick **Open tasks in editor** from the panel's **⋯** menu, to open the ProgressBoard as a full editor tab.

<GuideIntroHero />

<p class="hero-caption">The ProgressBoard: stream header and live log on the left, the run's output files on the right.</p>

## Layout overview

The ProgressBoard has two parts:

1.  **Task list**: In the sidebar, the **Tasks** button opens it as a drawer; in the editor tab it is docked beside the task.
2.  **Content Area**: The header and log details for the selected task.

## Stream tabs section

This section lists the stored tasks for the workspace, including tasks started earlier and from other TeXRA hosts; their conversations load from the workspace's SQLite database.

- **Switching tasks**: Select a task's title to view its logs and status in the Content Area.
- **Renaming or deleting a task**: Each row's <wa-icon library="texra" name="ellipsis"></wa-icon> menu offers **Rename…** and **Delete task**; deleting removes the stored task and its run folder, not just the row. Double-clicking a title also renames it.
- **Metadata**: A row's second line shows the agent, when the task was last active, and the model, with an icon for the kind of task.

## Content area

This area shows the details for the stream selected in the Stream Tabs section.

### Header

The header provides a summary and actions for the selected stream:

- **Task title**: Displays the title of the current task (select it to
  rename). Input files stay on the files panel, not on the task row.
- **Status indicator**: A colored circle shows the current status. The four states read at a glance:

<StatusDotLegend />

<p class="hero-caption">The status dot: green while running, yellow while waiting on you or interrupted, gray once finished or stopped, red on error.</p>

- **Token and cost summary**: Displays the combined input and output token counts from all completed revisions (e.g., `r0`, `r1`, `r2`, …) along with the estimated cost.
- **Header row**: Shows the **Tasks** button, the task's title, status and elapsed time (plus **Pass 2 of 3** for multi-pass document tasks), **Stop** while running (cancels the active request immediately where the provider supports it, or stops after the current API call finishes), **New task**, and the **Task actions** menu (`⋯`).
- **Task actions menu (`⋯`)**:
  - **All tasks**:
    - **Rename…**: Change the task title.
    - **Fork**: Branch the conversation into a new task (when the task can be forked), plus a link to each fork already made from it.
    - **Open task folder**: Reveal the run folder in run storage (`executions/<run-id>/`) to inspect generated files, compile logs, mirrored dependencies, and intermediate artifacts.
    - **Export conversation…**: Save the transcript as Markdown, HTML, or PDF.
    - **Copy diagnostics**: Copy the task's title, agent, model, status, task ID, output paths, and compile failures as plain text for bug reports or follow-up tasks.
    - **Delete task**: Remove the task once stopped.
  - **Document tasks**:
    - **Run again…**: Pre-fill the New task form with the same agent, model, files, and instruction to start a fresh run.
    - **Run latexdiff on the outputs**: Compare the original input `.tex` file(s) with the generated output `.tex` file(s) using `latexdiff` (read the [LaTeX Diff guide](./latex-diff.md)).
    - **Archive outputs to History**: Copy the run folder (outputs, logs, mirrored dependencies) into a timestamped folder under `History/` (read the [file management guide](./file-management.md)).
    - **Delete output files**: Remove the task's run folder.
  - **Chat tasks**: **Compact conversation** (summarize earlier turns).
  - **Global**: **Open tasks in editor** (or **Back to sidebar**) and **LaTeXDiffs…**.
- **After a task ends**: The composer area is replaced by a completion bar offering **Fork** (starts a new task with the conversation up to its last finished turn, leaving the original untouched) and, for interrupted tasks or workflows with saved outputs, **Resume** (continues from saved outputs instead of starting over). Hovering over any of your messages after the first also offers **Fork from here**, which branches the conversation before that message and places the message in the composer.

Reviewed outputs are accepted per file: each row under **Generated files** has
an **Accept** action that copies the edited version into your workspace.

### Checking an agent's launch

When an agent asks to start another agent, its card shows the agent, the
model, the instruction and the files it would run. **Edit** (`e`) opens the
New task form filled with that proposal. Change the files, the switches,
the instruction, the agent or the model, then press **Approve** to start it
with your changes. It still runs as the asking agent's child, and its
result goes back to that agent. **Back to …** returns to the asking task and
leaves the proposal waiting.

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

A small percentage next to the token count shows how full the model's context window is. When it climbs toward 100%, the conversation may get compacted automatically, or you may want to start a fresh session.

### After a workflow run

To follow up on a finished document task in chat, use **Copy diagnostics** in the
header menu to put the task's output paths and compile failures on the
clipboard, then start a chat from the **New** view and paste that text
into the instruction box.

When a run recorded a compile failure, **Fix compile errors** still appears under
**Generated files** and starts a repair chat from those logs.

### Memory

Agents can remember things between sessions. When memory is enabled (toggle in the Settings **Memory** tab), agents save useful notes about your project. You can browse, pin, and delete these notes from the **Memory** tab in Settings, reached with **TeXRA: Open Settings**. Read the [memory guide](./memory.md) for a full walkthrough.

### Log content

This scrollable area displays the detailed, timestamped logs for the selected agent run.

- **Structure**: Logs are organized into expandable groups (e.g., `Revision 1`). Response cycles are logged within the corresponding revision group. Select the arrow next to a group name to expand or collapse it.
- **Log levels**: Each line carries an icon for its severity. Debug-level lines, with timestamps and `INFO`, `DEBUG`, `WARN`, `ERROR` level prefixes, are only shown when `texra.logger.debugMode` is set to `true` in `<project>/.texra/config.json` or `~/.texra/v1/global-storage/config.json`; TeXRA does not read VS Code settings.
- **Agent thinking**: Model reasoning appears in shaded **Thinking** blocks, so you can spot when the model is exploring ideas.
- **Errors**: Errors are highlighted and often show what went wrong.

<ProgressLogHero />

<p class="hero-caption">The log: each row is color-keyed by severity (green for info/success, yellow for warnings, red for errors), with expandable nested detail and per-task IDs.</p>

The log content is the main source for diagnosing problems and seeing how TeXRA and the models process your requests. Read the [troubleshooting guide](./troubleshooting.md) for more on using logs.
