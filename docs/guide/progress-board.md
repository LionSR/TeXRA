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

The ProgressBoard is split into two main sections (usually side by side, but configurable):

1.  **Stream Tabs**: A list on the side (often right) showing different agent runs (streams).
2.  **Content Area**: The main area (often left) displaying the header and log details for the selected stream.

## Stream tabs section

This section lists the stored tasks for the workspace, including tasks started earlier and from other TeXRA hosts; their conversations load from the workspace's SQLite database.

- **Switching streams**: Select a stream name (e.g., `polish: paper.tex`) to view its logs and status in the Content Area.
- **Removing a stream**: Each tab has an <wa-icon library="texra" name="xmark"></wa-icon> button that removes that stream and its logs from the ProgressBoard view.
- **Metadata**: Tabs display the model and when the stream was last active on a second line. Icons indicate the agent type and whether multiple output files were generated.

## Content area

This area shows the details for the stream selected in the Stream Tabs section.

### Header

The header provides a summary and actions for the selected stream:

- **Stream name**: Displays the identifier of the current run.
  Tabs show the agent name (with `#executionId` when parallel runs would
  otherwise collide). Input files stay on the files panel, not on the tab chip.
  The model appears on the second line of the tab.
- **Status indicator**: A colored circle shows the current status. The four states read at a glance:

<StatusDotLegend />

<p class="hero-caption">The status dot: green while running, blue while waiting for input, gray once finished, red on error.</p>

- **Token and cost summary**: Displays the combined input and output token counts from all completed revisions (e.g., `r0`, `r1`, `r2`, …) along with the estimated cost.
- **Header row**: Shows the **Tasks** button, the task's title, status and elapsed time (plus **Pass 2 of 3** for multi-pass document tasks), **Stop** while running, **New task**, and the **More** menu (`⋯`).
- **More menu (`⋯`)**:
  - **All tasks**: Rename, Open task folder, Export (as Markdown, HTML, or PDF), Copy diagnostics, and Delete task (once stopped).
  - **Document tasks**: Run again… (pre-fills the New task form), latexdiff, Archive outputs, and Delete output files.
  - **Chat tasks**: Fork, Compact, and links to any forks created from the conversation.
  - **Global**: Open tasks in editor, LaTeXDiffs, and Figures.
- **After a task ends**: The composer area is replaced by a completion bar offering **Fork** (starts a new task with the conversation so far) and, for interrupted tasks or workflows with saved outputs, **Resume**. Hovering over any of your messages after the first also offers **Fork from here**, which branches the conversation before that message and places the message in the composer.

Each action in detail:

- <wa-icon library="texra" name="circle-stop"></wa-icon> **Stop**: Stops the running task for this stream. For providers supporting `AbortController` (like OpenAI or Anthropic) the active request is aborted immediately; otherwise the current API call finishes before stopping.
- <wa-icon library="texra" name="play"></wa-icon> **Run New**: Starts a fresh run of the task associated with this stream using the _exact same configuration_ (agent, model, files, instruction), discarding previous outputs. Useful for retrying failed tasks or reproducing results.
- <wa-icon library="texra" name="forward-step"></wa-icon> **Resume**: Continues the run from its saved outputs, picking up where it left off instead of starting over.
- <wa-icon library="texra" name="code-branch"></wa-icon> **Fork**: A new task holding this conversation up to its last finished turn, opened and waiting for your message; the original is left as it was.
- <wa-icon library="texra" name="code-compare"></wa-icon> **Diff**: Runs `latexdiff` to compare the original input file(s) with the generated output `.tex` file(s) from this stream. If no base file was selected, TeXRA uses the original file. Requires `latexdiff` to be installed. Read the [LaTeX Diff guide](./latex-diff.md).
- <wa-icon library="texra" name="folder-open"></wa-icon> **Open in run storage**:
  Reveals the run folder under run storage so you can browse generated
  files, compile logs, mirrored dependencies, and intermediate artifacts
  yourself.
- <wa-icon library="texra" name="copy"></wa-icon> **Copy diagnostics**: Copies
  the task's title, agent, model, status and id, its output paths, and its
  compile failures to the clipboard as plain text, for a bug report or to
  paste into a new task. It is the one place the task's id is shown.
- <wa-icon library="texra" name="box-archive"></wa-icon> **Pack**: Archives the output files and log for this stream into the `History` folder. Read the [file management guide](./file-management.md).
- <wa-icon library="texra" name="trash"></wa-icon> **Clean**: Deletes the run folder associated with this stream.

Reviewed outputs are accepted per file: each row under **Generated Files** has
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

An approval card's ▾ menu (**Approve all … in this run**) is where you let a
task approve a kind of request on its own: **edits**, **commands** or
**agent work**. Later requests of that kind in the task are approved without
asking. Edits and commands are independent. Agent work also covers the other
two, and turning it off returns all three to asking.

While a grant is on, the task's header shows an amber chip for it
(**Auto: edits**, **Auto: commands**, **Auto: agent work**); its × turns the
grant off. In the narrow sidebar one **Auto** chip stands for all of them,
and its × turns them all off. The composer's **Approval** chip sets the
policy a new task starts with. The CLI shows the same grants as AUTO-EDIT,
AUTO-BASH and AUTO-TASK badges.

### Context utilization

A small percentage next to the token count shows how full the model's context window is. When it climbs toward 100%, the conversation may get compacted automatically, or you may want to start a fresh session.

### After a workflow run

To follow up on a finished document task in chat, use **Copy diagnostics** in the
header menu to put the task's output paths and compile failures on the
clipboard, then start a chat from the **New** view and paste that text
into the instruction box.

When a run recorded a compile failure, **Fix compile errors** still appears under
**Generated Files** and starts a repair chat from those logs.

### Memory

Agents can remember things between sessions. When memory is enabled (toggle in the Settings **Memory** tab), agents save useful notes about your project. You can browse, pin, and delete these notes from the **Memory** tab in Settings, reached with **TeXRA: Open Settings**. Read the [memory guide](./memory.md) for a full walkthrough.

### Log content

This scrollable area displays the detailed, timestamped logs for the selected agent run.

- **Structure**: Logs are organized into expandable groups (e.g., `Initialization`, `Revision 1`, `Model Operation`). Response cycles are logged within the corresponding revision group. Select the arrow next to a group name to expand or collapse it.
- **Log levels**: Messages are prefixed with levels like `INFO`, `DEBUG`, `WARN`, `ERROR` to indicate severity. Verbose debug messages (`DEBUG`) are only shown when `texra.logger.debugMode` is set to `true` in `<project>/.texra/config.json` or `~/.texra/v1/global-storage/config.json`; TeXRA does not read VS Code settings.
- **Agent thinking**: The log highlights model reasoning in purple **Thinking** blocks. These sections are flagged internally with a `thinking` type so you can spot when the model is exploring ideas.
- **Errors**: Errors are highlighted and often show what went wrong.

<ProgressLogHero />

<p class="hero-caption">The log: each row is color-keyed by severity (green for info/success, yellow for warnings, red for errors), with expandable nested detail and per-task IDs.</p>

The log content is the main source for diagnosing problems and seeing how TeXRA and the models process your requests. Read the [troubleshooting guide](./troubleshooting.md) for more on using logs.
