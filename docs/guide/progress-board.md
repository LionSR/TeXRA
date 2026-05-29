<script setup>
import StreamHeaderActions from '../.vitepress/components/StreamHeaderActions.vue';
import StatusDotLegend from '../.vitepress/components/StatusDotLegend.vue';
import TodoLifecycle from '../.vitepress/components/TodoLifecycle.vue';
</script>

# ProgressBoard

The ProgressBoard is where you watch agents work and review what they did. Think of it as the flight recorder for every TeXRA run—you can see live progress, re-run a past job, or restore its settings with one click.

::: tip CLI
The ProgressBoard is the VS Code extension's live view. The CLI shows the same
streaming reasoning, tool calls, and diffs in its `texra chat` terminal UI. Past
runs are shared across surfaces — browse them with `texra history` or **Show
Agent Execution History** in VS Code.
:::

## Accessing the ProgressBoard

The ProgressBoard shares the **TeXRA view** in the Activity Bar with the launcher — click the TeXRA icon in the Activity Bar, then switch to the Progress view.

- **Automatic**: It often opens automatically when you execute an agent.
- **Manual**: Open it from the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) with **TeXRA: Show Progress**, or press `Ctrl+Alt+P` (`Cmd+Option+P` on macOS).
- **Editor tab**: Run **TeXRA: Open Progress in Editor Tab** to open the ProgressBoard as a full editor tab.

<GuideIntroHero />

<p class="hero-caption">The ProgressBoard: stream header and live log on the left, the run's output files on the right.</p>

## Layout Overview

The ProgressBoard interface is split into two main sections (usually side-by-side, but configurable):

1.  **Stream Tabs**: A list on the side (often right) showing different agent runs (streams).
2.  **Content Area**: The main area (often left) displaying the header and log details for the currently selected stream.

## Stream Tabs Section

This section lists all the agent execution streams from your current VS Code session.

- **Switching Streams**: Click on a stream name (e.g., `polish@sonnet46: paper.tex`) to view its specific logs and status in the Content Area.
- **Delete All**: The <wa-icon library="texra" name="trash"></wa-icon> **Delete All** button at the bottom permanently removes all streams and their logs from the ProgressBoard view for the current session.
- **Metadata**: Tabs display the model and when the stream was last active on a second line. Icons indicate the agent type and if multiple output files were generated.
- **Sorting**: Use the buttons below the tab list to order streams by time, input file, or agent name. The chosen order is saved for the workspace.

## Content Area

This area shows the details for the stream selected in the Stream Tabs section.

### Header

The header provides a summary and actions for the selected stream:

- **Stream Name**: Displays the identifier of the current run.
  Workflow agents use the familiar `agent@model: inputFile` format.
  Tool-use sessions show just the agent name so they stand alone even without an associated input file.
- **Status Indicator**: A colored circle shows the current status — the four states read at a glance:

<StatusDotLegend />

<p class="hero-caption">The status dot: only the running state pulses; stopped, error, and ready are static.</p>

- **Token & Cost Summary**: Displays the combined input and output token counts from all completed rounds (e.g., `r0`, `r1`, `r2`, …) along with the estimated cost.
- **Stream Header Actions**: A toolbar of icon buttons acting on the selected stream, in order — Stop, Run Again, Restore, Diff, Accept, Open in task storage, Pack, Clean, and Erase.

<StreamHeaderActions />

<p class="hero-caption">The stream header: identity and token/cost summary on the left, the action toolbar on the right — every icon mapped to its action.</p>

Each action in detail:

- <wa-icon library="texra" name="debug-stop"></wa-icon> **Stop**: Attempts to gracefully stop the currently running task for this stream. For providers supporting `AbortController` (like OpenAI or Anthropic) the active request is aborted immediately; otherwise the current API call will finish before stopping.
- <wa-icon library="texra" name="debug-rerun"></wa-icon> **Run Again**: Re-runs the task associated with this stream using the _exact same configuration_ (agent, model, files, instruction) that was used when it originally ran. Useful for retrying failed tasks or reproducing results.
- <wa-icon library="texra" name="reply"></wa-icon> **Restore**: Loads the configuration (agent, model, files, instruction) from this stream back into the main TeXRA webview interface. This allows you to easily modify and re-run a previous task.
- <wa-icon library="texra" name="diff-multiple"></wa-icon> **Diff**: Triggers the `latexdiff` process to compare the original input file(s) with the generated output `.tex` file(s) from this stream. If no base file was selected, TeXRA automatically falls back to the original file. Requires `latexdiff` to be installed. See [LaTeX Diff](./latex-diff.md).
- <wa-icon library="texra" name="check"></wa-icon> **Accept**: After reviewing a diff, replace the base file with the edited version.
- <wa-icon library="texra" name="folder-opened"></wa-icon> **Open in task storage**:
  Reveals the run folder under task-run storage so you can browse generated
  files, compile logs, mirrored dependencies, and intermediate artifacts
  manually.
- <wa-icon library="texra" name="archive"></wa-icon> **Pack**: Archives the output files and log for this stream into the `History` folder. See [File Management](./file-management.md).
- <wa-icon library="texra" name="trash"></wa-icon> **Clean**: Deletes the task storage folder associated with this stream.
- <wa-icon library="texra" name="clear-all"></wa-icon> **Erase**: Removes this stream and its log content entirely from the ProgressBoard.

### YOLO Mode

Tired of clicking "Approve" on every file edit? The **YOLO mode** toggle in the header lets tool-use agents run hands-free - they'll edit files, run commands, and search the web without stopping to ask. Great for tasks you trust; just flip it off when you want to review each step.

### Context Utilization

A small percentage next to the token count shows how full the model's context window is. When it climbs toward 100%, the conversation may get compacted automatically or you might want to start a fresh session.

### Todo List

When a tool-use agent tackles a multi-step task, it shows a **live checklist** right in the ProgressBoard. Each item moves from Pending to In Progress to Completed so you always know what the agent is working on and how far along it is.

<TodoLifecycle />

<p class="hero-caption">A live checklist: completed items are checked and struck through, the active item spins, pending items wait.</p>

### Followup Tasks

Finished a polish run and want to discuss the results or merge the outputs? Instead of setting everything up again, use the **Followup** controls that appear after a workflow completes:

- **Chat** about what the agent changed
- **Run another agent** (like `merge`) on the output files

The followup picks up right where the previous run left off - no need to re-select files or re-enter your instruction.

### Memory

Tool-use agents can remember things between sessions. When memory is enabled (toggle in the toolbar), agents save useful notes about your project. You can browse, pin, and delete these notes from the **Memory** tab in the Dashboard, or by running **TeXRA: Show Memory** from the Command Palette. See the [Memory guide](./memory.md) for a full walkthrough.

### Log Content

This scrollable area displays the detailed, timestamped logs for the selected agent run.

- **Structure**: Logs are organized into expandable/collapsible groups (e.g., `Initialization`, `Round 0`, `Model Operation`). Response cycles are logged within the corresponding round group. Click the arrow next to a group name to toggle it.
- **Log Levels**: Messages are prefixed with levels like `INFO`, `DEBUG`, `WARN`, `ERROR` to indicate severity. Verbose debug messages (`DEBUG`) are only shown if `texra.logger.debugMode` is enabled in settings.
- **Agent Thinking**: The log highlights model reasoning in purple **Thinking** blocks. These sections are flagged internally with a `thinking` type so you can easily spot when the AI is exploring ideas.
- **Errors**: Errors are highlighted, often providing clues if something went wrong.

Understanding the log content is key to diagnosing problems and seeing how TeXRA and the AI models process your requests. Refer to the [Troubleshooting](./troubleshooting.md) guide for more tips on using logs.

At the bottom of the tab list, there is a "Delete All" button (<wa-icon library="texra" name="close-all"></wa-icon>) that allows you to clear all streams and their associated logs from the ProgressBoard view.
Above the sorter, the **All / Workflow / Tool Use** buttons let you focus the tab list on specific agent types.
Next to "Delete All" are sorting buttons (<wa-icon library="texra" name="clock"></wa-icon>, <wa-icon library="texra" name="file"></wa-icon>, <wa-icon library="texra" name="account"></wa-icon>) for ordering the tabs.
