<script setup>
import StreamHeaderActions from '../.vitepress/components/StreamHeaderActions.vue';
import StatusDotLegend from '../.vitepress/components/StatusDotLegend.vue';
import TodoLifecycle from '../.vitepress/components/TodoLifecycle.vue';
import ProgressLogHero from '../.vitepress/components/ProgressLogHero.vue';
import CliHistoryHero from '../.vitepress/components/CliHistoryHero.vue';
</script>

# ProgressBoard

The ProgressBoard is where you watch agents work and review what they did. Think of it as the flight recorder for every TeXRA run—you can see live progress, re-run a past job, or restore its settings with one click.

::: tip CLI
The ProgressBoard is the VS Code extension's live view. The CLI shows the same
streaming reasoning, tool calls, and diffs in its `texra chat` terminal UI. Past
runs are shared across surfaces — browse them with `texra history` or **Show
Agent Execution History** in VS Code.
:::

<CliHistoryHero />

<p class="hero-caption">The board's runs, from a terminal: the same executions, one tab-separated row each — and <code>texra resume</code> picks a stored session back up.</p>

## Accessing the ProgressBoard

The ProgressBoard shares the **TeXRA view** with the launcher — click the TeXRA icon in the Secondary Side Bar, then switch to the Progress view.

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

- **Switching Streams**: Click on a stream name (e.g., `polish: paper.tex`) to view its specific logs and status in the Content Area.
- **Removing a Stream**: Each tab has an <wa-icon library="texra" name="xmark"></wa-icon> button that removes that stream and its logs from the ProgressBoard view.
- **Metadata**: Tabs display the model and when the stream was last active on a second line. Icons indicate the agent type and if multiple output files were generated.

## Content Area

This area shows the details for the stream selected in the Stream Tabs section.

### Header

The header provides a summary and actions for the selected stream:

- **Stream Name**: Displays the identifier of the current run.
  Tabs show the agent name (with `#executionId` when parallel runs would
  otherwise collide). Input files stay on the files panel, not on the tab chip.
  The model rides on the second line of the tab.
- **Status Indicator**: A colored circle shows the current status — the four states read at a glance:

<StatusDotLegend />

<p class="hero-caption">The status dot: green while running, blue while waiting for input, grey once finished, red on error.</p>

- **Token & Cost Summary**: Displays the combined input and output token counts from all completed rounds (e.g., `r0`, `r1`, `r2`, …) along with the estimated cost.
- **Stream Header Actions**: A toolbar of icon buttons acting on the selected stream. Workflow streams get Stop, Run New, Resume, Restore, Open in task storage, Copy run context, Diff, Clean, and Pack; tool-use streams get Stop, YOLO, agent-work approval, Compact, Restore, and Open in task storage.

<StreamHeaderActions />

<p class="hero-caption">The stream header: identity and token/cost summary on the left, the action toolbar on the right — every icon mapped to its action.</p>

Each action in detail:

- <wa-icon library="texra" name="circle-stop"></wa-icon> **Stop**: Attempts to gracefully stop the currently running task for this stream. For providers supporting `AbortController` (like OpenAI or Anthropic) the active request is aborted immediately; otherwise the current API call will finish before stopping.
- <wa-icon library="texra" name="play"></wa-icon> **Run New**: Starts a fresh run of the task associated with this stream using the _exact same configuration_ (agent, model, files, instruction), discarding previous outputs. Useful for retrying failed tasks or reproducing results.
- <wa-icon library="texra" name="forward-step"></wa-icon> **Resume**: Continues the run from its saved outputs, picking up where it left off instead of starting over.
- <wa-icon library="texra" name="reply"></wa-icon> **Restore**: Loads the configuration (agent, model, files, instruction) from this stream back into the main TeXRA webview interface. This allows you to easily modify and re-run a previous task.
- <wa-icon library="texra" name="code-compare"></wa-icon> **Diff**: Triggers the `latexdiff` process to compare the original input file(s) with the generated output `.tex` file(s) from this stream. If no base file was selected, TeXRA automatically falls back to the original file. Requires `latexdiff` to be installed. See [LaTeX Diff](./latex-diff.md).
- <wa-icon library="texra" name="folder-open"></wa-icon> **Open in task storage**:
  Reveals the run folder under task-run storage so you can browse generated
  files, compile logs, mirrored dependencies, and intermediate artifacts
  manually.
- <wa-icon library="texra" name="copy"></wa-icon> **Copy run context**: Copies the
  run identity, output paths, and compile failures to the clipboard as plain
  text, so you can paste them into a new tool-use chat. The button is disabled
  when the run has neither outputs nor compile failures.
- <wa-icon library="texra" name="box-archive"></wa-icon> **Pack**: Archives the output files and log for this stream into the `History` folder. See [File Management](./file-management.md).
- <wa-icon library="texra" name="trash"></wa-icon> **Clean**: Deletes the task storage folder associated with this stream.

Reviewed outputs are accepted per file: each row under **Generated Files** has
an **Accept** action that copies the edited version into your workspace.

### YOLO Mode

Tired of clicking "Approve" on every file edit? The **YOLO mode** toggle in the header lets tool-use agents run hands-free - they'll edit files, run commands, and search the web without stopping to ask. Great for tasks you trust; just flip it off when you want to review each step.

### Context Utilization

A small percentage next to the token count shows how full the model's context window is. When it climbs toward 100%, the conversation may get compacted automatically or you might want to start a fresh session.

### Todo List

When a tool-use agent tackles a multi-step task, it shows a **live checklist** right in the ProgressBoard. Each item moves from Pending to In Progress to Completed so you always know what the agent is working on and how far along it is.

<TodoLifecycle />

<p class="hero-caption">A live checklist: completed items are checked and struck through, the active item spins, pending items wait.</p>

### After a workflow run

The ProgressBoard no longer starts a general-purpose chat from a finished
workflow. Use **Copy run context** in the header toolbar to put the run's
output paths and compile failures on the clipboard, then start a tool-use chat
from the **New** view and paste that text into the instruction box.

When a run recorded a compile failure, **Run latexFixer** still appears under
**Generated Files** and starts a repair chat from those logs.

### Memory

Tool-use agents can remember things between sessions. When memory is enabled (toggle in the Dashboard's **Memory** tab), agents save useful notes about your project. You can browse, pin, and delete these notes from the **Memory** tab in the Dashboard, or by running **TeXRA: Show Memory** from the Command Palette. See the [Memory guide](./memory.md) for a full walkthrough.

### Log Content

This scrollable area displays the detailed, timestamped logs for the selected agent run.

- **Structure**: Logs are organized into expandable/collapsible groups (e.g., `Initialization`, `Round 0`, `Model Operation`). Response cycles are logged within the corresponding round group. Click the arrow next to a group name to toggle it.
- **Log Levels**: Messages are prefixed with levels like `INFO`, `DEBUG`, `WARN`, `ERROR` to indicate severity. Verbose debug messages (`DEBUG`) are only shown when debug mode (`texra.logger.debugMode`) is enabled in your `.texra/config.json` or VS Code settings.
- **Agent Thinking**: The log highlights model reasoning in purple **Thinking** blocks. These sections are flagged internally with a `thinking` type so you can easily spot when the AI is exploring ideas.
- **Errors**: Errors are highlighted, often providing clues if something went wrong.

<ProgressLogHero />

<p class="hero-caption">The log: each row is color-keyed by severity — green for info/success, yellow for warnings, red for errors — with expandable nested detail and per-task IDs.</p>

Understanding the log content is key to diagnosing problems and seeing how TeXRA and the AI models process your requests. Refer to the [Troubleshooting](./troubleshooting.md) guide for more tips on using logs.
