# Agent Explorer

The TeXRA extension includes a dedicated **Agent Explorer** view within the VS Code sidebar, typically located under the main TeXRA panel (identified by the logo icon). Think of it as your command center for browsing, inspecting, and managing the AI personalities (agent definition files) that power TeXRA's capabilities.

![TeX Agents View Placeholder](/images/agent-explorer-view.png)

## Structure

The Agent Explorer is organized into two main sections:

1.  **Built-in Agents**: This section displays the standard agents that come bundled with the TeXRA extension. These files (`.yaml`) define the core functionalities like `correct`, `polish`, `draw`, etc.
2.  **Custom Agents**: This section displays agents that you have created or added yourself. When the `texra.explorer.agentsDirectory` setting is left blank, TeXRA seeds a `custom_agents` folder inside its global storage and shows it here automatically. You can override the location with an absolute path in VS Code settings if you want to manage the files elsewhere.

## Browsing and Viewing Agents

- **Expand/Collapse**: Click the arrows next to folder names (including "Built-in Agents" and "Custom Agents") to expand or collapse them.
- **File Icons**: Folders are marked with a folder icon <i class="codicon codicon-folder"></i>, and agent definition files (usually `.yaml`) are marked with a file icon <i class="codicon codicon-file"></i>.
- **Opening Files**: Click on an agent file name to open it in the editor.
  - **Built-in Agents**: These files are **read-only** to prevent accidental modification of core functionalities (it's usually best not to tinker with the pre-built magic!). They will be marked with a lock icon <i class="codicon codicon-lock"></i> and VS Code will prevent saving changes. If you want to modify a built-in agent, it's recommended to create a copy in your Custom Agents directory.
  - **Custom Agents**: These files can be opened and edited normally.

## Managing Custom Agents

You can manage your custom agent files directly within the "Custom Agents" section of the explorer:

- **Right-Click**: Right-click on a file or folder within the "Custom Agents" section (or on the "Custom Agents" root folder itself) to access the context menu.
- **Title Bar Icons**: Some actions might also be available via icons in the view's title bar when the "TeX Agents" view is focused.

Available actions for **Custom Agents** include:

- **New File** <i class="codicon codicon-new-file"></i>: Creates a new file populated with a starter template (e.g., `new-file.yaml`) within the selected folder (or the root custom agents folder). You will be prompted to rename it immediately.
- **New Folder** <i class="codicon codicon-new-folder"></i>: Creates a new folder within the selected folder. You will be prompted to rename it.
- **Rename** <i class="codicon codicon-edit"></i>: Renames the selected custom file or folder.
- **Delete** <i class="codicon codicon-trash"></i>: Deletes the selected custom file or folder (with confirmation).
- **Add Agent to Config** <i class="codicon codicon-diff-added"></i>: Validates a YAML file and adds its agent name to `texra.agents`.
- **Create AI Agent** <i class="codicon codicon-sparkle"></i>: Launches a wizard that collects a short description and output style (single vs. multiple files) then generates a starter YAML using Claude. See [Strict XML Extraction](./custom-agents.md#strict-xml-extraction) for why the YAML must be precise.
- **Reveal in OS** <i class="codicon codicon-folder-opened"></i>: Opens the selected
  folder in your operating system's file explorer so you can paste or manage files
  directly.

**Important**: These management actions (New File, New Folder, Rename, Delete) are **not available** for items within the "Built-in Agents" section.

## Relationship to Custom Agent Creation

The Agent Explorer is where you manage the files you create following the steps in the [Custom Agents](./custom-agents.md) guide. Use the explorer to organize your agent `.yaml` files effectively.

## Agent Configuration Alerts

When an agent name is listed in `texra.agents` but its YAML file is missing, the
agent appears disabled in the main view dropdown. Choosing such an entry shows a
banner offering to edit the agent list, open or set the custom agents directory,
or view documentation. Agents that include a companion `<agent>_multiple.yaml`
are flagged with a codicon in the dropdown to indicate multi-output support.
