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

- **Switching Streams**: Click on a stream name (e.g., `polish@sonnet37: paper.tex`) to view its specific logs and status in the Content Area.
- **Delete All**: The <i class="codicon codicon-trash"></i> **Delete All** button at the bottom permanently removes all streams and their logs from the ProgressBoard view for the current session.

## Content Area

This area shows the details for the stream selected in the Stream Tabs section.

### Header

The header provides a summary and actions for the selected stream:

- **Stream Name**: Displays the identifier of the current run (e.g., `agent@model: inputFile`).
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

## Features

### Stream Management
- **Multiple Streams**: Monitor multiple concurrent agent executions
- **Stream Switching**: Click between different agent streams  
- **Stream Controls**: Stop, re-run, diff, pack, clean, and delete operations

### Structured Logging
- **Hierarchical Groups**: Nested log groups for different execution phases
- **Message Types**: Differentiated styling for info, warning, error, debug messages
- **Special Content**: Formatted thinking blocks and scratchpad content
- **Timestamps**: Detailed timing information for all operations

### File Loading Status (NEW)
The Progress Board now displays structured file loading information chronologically as special log messages:

#### Required Files
Shows the status of required files loaded via `setVarFromFile`:
```
[r0] Required Files: ✓ 2 found, ⚠ 1 missing
    Found: lecture.cls, command.tex
    Missing: missing_file.tex
```

#### Media Files  
Displays media files loaded for vision-enabled models:
```
[r0] Added Media: 3 files
    Fig1.pdf, Fig8.pdf, illustration.png
```

#### Features
- **Chronological Display**: Files appear exactly when loaded during execution
- **Round Separation**: Each round (r0, r1) shows separate file loading events
- **Clickable Files**: Click on file paths to open them in VS Code
- **Status Indicators**: Clear visual indicators for found/missing files
- **Round Indicators**: [r0], [r1] badges show which execution round loaded the files

#### File Types Supported
- **Required Files**: LaTeX documents, style files, bibliographies
- **Media Files**: PDFs, images (PNG, JPG, etc.) for vision models
- **Workspace Files**: Clickable workspace-relative paths
- **Absolute Files**: System paths (not clickable for security)

### Output File Management
- **Generated Files**: Track all files created by agents
- **File Actions**: Open, compare, accept, merge, and diff operations
- **Latexdiff Integration**: Visual comparison between file versions
- **Round Tracking**: Separate file lists for each execution round

### Performance Monitoring
- **Token Usage**: Real-time tracking of input/output tokens and costs
- **Response Times**: Monitor model response latency
- **Resource Usage**: Cache usage and API consumption metrics
- **Group Statistics**: Aggregated statistics for log groups

### Interactive Controls
- **File Operations**: Click to open, compare, or process generated files
- **Stream Actions**: Toolbar buttons for common stream operations
- **State Management**: Restore previous execution states
- **Export Functions**: Pack and clean operations for file management

## Usage

### Basic Monitoring
1. **Start an Agent**: Execute any agent to create a new stream
2. **Monitor Progress**: Watch real-time logs and file loading status
3. **Review Files**: Click on file paths to open them in VS Code
4. **Track Status**: Monitor execution status and resource usage

### File Loading Insights
- **Required File Issues**: Quickly identify missing dependencies
- **Media Loading**: Verify which figures/images are processed
- **Round Progression**: See how file loading differs between rounds
- **Debugging**: Use file status to troubleshoot execution issues

### Advanced Operations
- **Stream Comparison**: Use diff operations to compare streams
- **State Restoration**: Resume interrupted or modified executions  
- **Bulk Operations**: Pack or clean multiple files at once
- **History Access**: Review previous execution logs and states

The Progress Board provides comprehensive visibility into agent execution, making it easier to debug issues, track progress, and manage the generated files.

## Configuration

Progress Board behavior can be customized through VS Code settings:
- **Debug Mode**: Enable detailed logging for troubleshooting
- **Auto-focus**: Control when the Progress Board gains focus
- **File Limits**: Configure maximum files displayed per stream
