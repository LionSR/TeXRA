# ProgressBoard

The ProgressBoard monitors agent execution, displays logs, and manages past runs.

## Accessing the ProgressBoard

The ProgressBoard typically appears in the **Panel area** at the bottom of your VS Code window.

- **Automatic**: It often opens automatically when you execute an agent.
- **Manual**: If it's closed, you can open it via the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) by searching for `View: Show TeXRA ProgressBoard`, or press `Ctrl+Alt+P` (`Cmd+Option+P` on macOS).

![ProgressBoard Layout Placeholder](/images/progress-board-layout.png)

## Layout Overview

The ProgressBoard interface is split into two main sections (usually side-by-side, but configurable):

1.  **Stream Tabs**: A list on the side (often right) showing different agent runs (streams).
2.  **Content Area**: The main area (often left) displaying the header and log details for the currently selected stream.

## Stream Tabs Section

This section lists all the agent execution streams from your current VS Code session.

- **Switching Streams**: Click on a stream name (e.g., `polish@sonnet45: paper.tex`) to view its logs
- **Delete All**: Removes all streams and logs from the current session
- **Metadata**: Tabs show the model and last active time
- **Sorting**: Order streams by time, input file, or agent name

## Content Area

This area shows the details for the stream selected in the Stream Tabs section.

### Header

The header provides a summary and actions for the selected stream:

- **Stream Name**: Displays the identifier of the current run.
  Workflow agents use the familiar `agent@model: inputFile` format.
  Tool-use sessions show just the agent name so they stand alone even without an associated input file.
- **Status Indicator**: A colored circle shows the current status:
  - **Green (Running)**: The agent is actively processing.
  - **Grey (Stopped)**: The agent finished successfully or was stopped manually before completion.
  - **Red (Error)**: The agent encountered an error during execution.
  - **Yellow (Ready/Initial)**: The view is ready, but no stream is active yet.
- **Token & Cost Summary**: Shows combined token counts and estimated cost

**Actions** (in header toolbar):

- <i class="codicon codicon-debug-stop"></i> **Stop**: Stop the currently running task
- <i class="codicon codicon-debug-rerun"></i> **Run Again**: Re-run with the same configuration
- <i class="codicon codicon-reply"></i> **Restore**: Load configuration back into main TeXRA UI
- <i class="codicon codicon-diff-multiple"></i> **Diff**: Generate latexdiff comparison (see [LaTeX Diff](./latex-diff.md))
- <i class="codicon codicon-check"></i> **Accept**: Replace base file with edited version
- <i class="codicon codicon-archive"></i> **Pack**: Archive to History folder
- <i class="codicon codicon-trash"></i> **Clean**: Delete output files
- <i class="codicon codicon-clear-all"></i> **Erase**: Remove stream from ProgressBoard

### Log Content

This scrollable area displays the detailed, timestamped logs for the selected agent run.

- **Structure**: Logs are organized into expandable/collapsible groups (e.g., `Initialization`, `Round 0`, `Model Operation`). Response cycles are logged within the corresponding round group. Click the arrow next to a group name to toggle it.
- **Log Levels**: Messages are prefixed with levels like `INFO`, `DEBUG`, `WARN`, `ERROR` to indicate severity. Verbose debug messages (`DEBUG`) are only shown if `texra.logger.debugMode` is enabled in settings.
- **Agent Thinking**: The log highlights model reasoning in purple **Thinking** blocks. These sections are flagged internally with a `thinking` type so you can easily spot when the AI is exploring ideas.
- **Errors**: Errors are highlighted, often providing clues if something went wrong.

Understanding the log content is key to diagnosing problems and seeing how TeXRA and the AI models process your requests. Refer to the [Troubleshooting](../reference/troubleshooting.md) guide for more tips on using logs.

Filter tabs by agent type using the **All / Workflow / Tool Use** buttons. Use the sorting buttons (<i class="codicon codicon-clock"></i> time, <i class="codicon codicon-file"></i> file, <i class="codicon codicon-account"></i> agent) to order tabs. The <i class="codicon codicon-close-all"></i> **Delete All** button clears all streams.
