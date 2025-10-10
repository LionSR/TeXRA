# ProgressBoard

The ProgressBoard is TeXRA's central hub for monitoring agent execution, viewing detailed logs, and managing past runs. Think of it as the mission control center for your AI assistant – essential for understanding what's happening under the hood and troubleshooting when things go sideways.

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

- **Switching Streams**: Click on a stream name (e.g., `polish@sonnet45: paper.tex`) to view its specific logs and status in the Content Area.
- **Delete All**: The <i class="codicon codicon-trash"></i> **Delete All** button at the bottom permanently removes all streams and their logs from the ProgressBoard view for the current session.
- **Metadata**: Tabs display the model and when the stream was last active on a second line. Icons indicate the agent type and if multiple output files were generated.
- **Sorting**: Use the buttons below the tab list to order streams by time, input file, or agent name. The chosen order is saved for the workspace.

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
- **Token & Cost Summary**: Displays the combined input and output token counts
  from all completed rounds (`r0` and `r1`) along with the estimated cost.
- **Stream Header Actions**:
  - <i class="codicon codicon-debug-stop"></i> **Stop**: Attempts to gracefully stop the currently running task for this stream. For providers supporting `AbortController` (like OpenAI or Anthropic) the active request is aborted immediately; otherwise the current API call will finish before stopping.
  - <i class="codicon codicon-debug-rerun"></i> **Run Again**: Re-runs the task associated with this stream using the _exact same configuration_ (agent, model, files, instruction) that was used when it originally ran. Useful for retrying failed tasks or reproducing results.
  - <i class="codicon codicon-reply"></i> **Restore**: Loads the configuration (agent, model, files, instruction) from this stream back into the main TeXRA webview interface. This allows you to easily modify and re-run a previous task.
  - <i class="codicon codicon-diff-multiple"></i> **Diff**: Triggers the `latexdiff` process to compare the original input file(s) with the generated output `.tex` file(s) from this stream. Generates `_diff_rN.tex` and `_diff_rN-rM.tex` files. If no base file was selected, TeXRA automatically falls back to the original file. Requires `latexdiff` to be installed. See [LaTeX Diff](./latex-diff.md).
  - <i class="codicon codicon-check"></i> **Accept**: After reviewing a diff, replace the base file with the edited version.
  - <i class="codicon codicon-archive"></i> **Pack**: Archives the output files and log for this stream into the `History` folder. See [File Management](./file-management.md).
  - <i class="codicon codicon-trash"></i> **Clean**: Deletes the output files associated with this stream.
  - <i class="codicon codicon-clear-all"></i> **Erase**: Removes this stream and its log content entirely from the ProgressBoard.

### Log Content

This scrollable area displays the detailed, timestamped logs for the selected agent run.

- **Structure**: Logs are organized into expandable/collapsible groups (e.g., `Initialization`, `Round 0`, `Model Operation`). Response cycles are logged within the corresponding round group. Click the arrow next to a group name to toggle it.
- **Log Levels**: Messages are prefixed with levels like `INFO`, `DEBUG`, `WARN`, `ERROR` to indicate severity. Verbose debug messages (`DEBUG`) are only shown if `texra.logger.debugMode` is enabled in settings.
- **Agent Thinking**: The log highlights model reasoning in purple **Thinking** blocks. These sections are flagged internally with a `thinking` type so you can easily spot when the AI is exploring ideas.
- **Errors**: Errors are highlighted, often providing clues if something went wrong.

Understanding the log content is key to diagnosing problems and seeing how TeXRA and the AI models process your requests. Refer to the [Troubleshooting](../reference/troubleshooting.md) guide for more tips on using logs.

At the bottom of the tab list, there is a "Delete All" button (<i class="codicon codicon-close-all"></i>) that allows you to clear all streams and their associated logs from the ProgressBoard view.
Above the sorter, the **All / Workflow / Tool Use** buttons let you focus the tab list on specific agent types.
Next to "Delete All" are sorting buttons (<i class="codicon codicon-clock"></i>, <i class="codicon codicon-file"></i>, <i class="codicon codicon-account"></i>) for ordering the tabs.
