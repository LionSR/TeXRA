// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - explorer
import { FileItem } from './FileItem';
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

// Local imports
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';

import { AbsoluteFS } from '@utils/files';
import { safeExecuteCommand } from '@utils/system/commandUtils';
import { validateYamlAndPromptAdd } from '@frontend/agents/register';

import * as logger from '@logger/logUtils';

const NEW_AGENT_TEMPLATE = `# --- Agent Inheritance (Optional) ---
# inherits: base

name: my_agent

# --- Agent Settings ---
settings:
  agentType: CoT
  temperature: 0.1
  isRewrite: true
  documentTag: document
  endTag: '</document>'
  outputExt: tex
  prefills:
    - "<document>"

# --- Agent Prompts ---
prompts:
  systemPrompt: |
    [Define the AI's role and core instructions]

  userPrefix: |
    [Provide context using variables like {{ INPUT_CONTENT }}]

  userRequest: |
    [Define the initial task prompt]
`;

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class ExplorerOperations {
  private builtInAgentsPath = '';
  private builtInToolUsePath = '';
  private editingItem: FileItem | undefined;

  constructor(
    private workspaceRoot: string | undefined,
    private context: vscode.ExtensionContext | undefined,
    private refresh: () => void,
  ) {
    if (this.context) {
      agentDirectories.builtIn(this.context).then((p) => {
        this.builtInAgentsPath = p;
      });
      agentDirectories.builtInToolUse(this.context).then((p) => {
        this.builtInToolUsePath = p;
      });
    }
  }

  async open(uri: vscode.Uri) {
    try {
      const isBuiltIn =
        (this.builtInAgentsPath &&
          uri.fsPath.startsWith(this.builtInAgentsPath)) ||
        (this.builtInToolUsePath &&
          uri.fsPath.startsWith(this.builtInToolUsePath));

      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);

      if (isBuiltIn) {
        await vscode.commands.executeCommand(
          'workbench.action.files.setActiveEditorReadonlyInSession',
        );
        const message =
          'This is a built-in agent prompt file and should not be modified directly.';
        const createCustom = 'Create Custom Copy';
        vscode.window
          .showWarningMessage(message, createCustom)
          .then((selection) => {
            if (selection === createCustom) {
              this.createCustomCopy(uri);
            }
          });
      }
    } catch (err) {
      await showLoggedErrorMessage(CHANNEL, 'Error opening file', err);
    }
  }

  async reveal(uri: vscode.Uri) {
    await safeExecuteCommand('revealFileInOS', [uri], CHANNEL);
  }

  private async createCustomCopy(uri: vscode.Uri) {
    try {
      const customPath = await agentDirectories.ensureCustom();

      const base = uri.fsPath.startsWith(this.builtInToolUsePath)
        ? this.builtInToolUsePath
        : this.builtInAgentsPath;
      const relativePath = path.relative(base, uri.fsPath);
      const targetPath = path.join(customPath, relativePath);

      const targetDir = path.dirname(targetPath);
      await AbsoluteFS.ensureDir(targetDir);

      await AbsoluteFS.copy(uri.fsPath, targetPath);

      const newDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(targetPath),
      );
      await vscode.window.showTextDocument(newDoc);

      vscode.window.showInformationMessage(
        `Created custom copy at: ${targetPath}`,
      );
    } catch (err) {
      await showLoggedErrorMessage(CHANNEL, 'Error creating custom copy', err);
    }
  }

  async create(node: FileItem | undefined, isFolder: boolean) {
    try {
      const customBase = await agentDirectories.ensureCustom();

      let parentPath = node?.resourceUri.fsPath || customBase;

      if (
        parentPath.startsWith(this.builtInAgentsPath) ||
        parentPath.startsWith(this.builtInToolUsePath)
      ) {
        const base = parentPath.startsWith(this.builtInToolUsePath)
          ? this.builtInToolUsePath
          : this.builtInAgentsPath;
        const relative = path.relative(base, parentPath);
        parentPath = path.join(customBase, relative);
      }

      if (!parentPath) {
        throw new Error('No valid parent path found');
      }

      await AbsoluteFS.ensureDir(parentPath);

      const tempName = isFolder ? 'New Folder' : 'new-file.yaml';
      const resourceUri = vscode.Uri.file(path.join(parentPath, tempName));

      const newItem = new FileItem(
        tempName,
        resourceUri,
        isFolder
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );

      newItem.editing = true;
      this.editingItem = newItem;

      this.refresh();

      await this.rename(newItem);
    } catch (err) {
      await showLoggedErrorMessage(
        CHANNEL,
        `Failed to create new ${isFolder ? 'folder' : 'file'}`,
        err,
      );
    }
  }

  async rename(item: FileItem) {
    if (!item) {
      return;
    }

    if (item.isBuiltIn) {
      vscode.window.showWarningMessage(
        'Built-in agent files cannot be renamed. Create a custom copy instead.',
      );
      return;
    }

    this.editingItem = item;
    item.editing = true;
    this.refresh();

    const newName = await vscode.window.showInputBox({
      value: item.label,
      prompt: `Enter new name for ${item.label}`,
      validateInput: (value) => {
        if (!value) {
          return 'Name cannot be empty';
        }
        if (value.includes('/') || value.includes('\\')) {
          return 'Name cannot contain path separators';
        }
        return null;
      },
    });

    let createdFile: vscode.Uri | undefined;

    if (newName && newName !== item.label) {
      const oldPath = item.resourceUri.fsPath;
      const newPath = path.join(path.dirname(oldPath), newName);

      try {
        await AbsoluteFS.rename(oldPath, newPath, { overwrite: false });
      } catch (err: any) {
        const fileNotFound =
          err?.code === 'ENOENT' ||
          (err instanceof vscode.FileSystemError &&
            err.code === 'FileNotFound');
        if (fileNotFound) {
          try {
            if (
              item.collapsibleState === vscode.TreeItemCollapsibleState.None
            ) {
              const content = newPath.endsWith('.yaml')
                ? NEW_AGENT_TEMPLATE
                : '';
              await AbsoluteFS.write(newPath, content);
              createdFile = vscode.Uri.file(newPath);
            } else {
              await AbsoluteFS.ensureDir(newPath);
            }
          } catch (createErr) {
            await showLoggedErrorMessage(
              CHANNEL,
              'Failed to create item',
              createErr,
            );
          }
        } else {
          await showLoggedErrorMessage(CHANNEL, 'Failed to rename item', err);
        }
      }
    }

    if (createdFile) {
      const doc = await vscode.workspace.openTextDocument(createdFile);
      await vscode.window.showTextDocument(doc);
    }

    this.editingItem = undefined;
    item.editing = false;
    this.refresh();
  }

  async delete(item: FileItem) {
    if (!item) {
      return;
    }

    if (item.isBuiltIn) {
      vscode.window.showWarningMessage(
        'Built-in agent files cannot be deleted. Create a custom copy if you need to modify them.',
      );
      return;
    }

    const isFolder =
      item.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed;
    const confirmMessage = `Are you sure you want to delete ${isFolder ? 'folder' : 'file'} "${item.label}"?`;
    const confirmButton = 'Delete';

    const choice = await vscode.window.showWarningMessage(
      confirmMessage,
      { modal: true },
      confirmButton,
    );

    if (choice === confirmButton) {
      try {
        if (isFolder) {
          await AbsoluteFS.delete(item.resourceUri.fsPath, {
            recursive: true,
          });
        } else {
          await AbsoluteFS.delete(item.resourceUri.fsPath);
        }
        logger.info(
          CHANNEL,
          `Successfully deleted ${isFolder ? 'folder' : 'file'}: ${item.resourceUri.fsPath}`,
        );
      } catch (err) {
        await showLoggedErrorMessage(
          CHANNEL,
          `Failed to delete ${isFolder ? 'folder' : 'file'}`,
          err,
        );
      }
    }
  }

  async addToList(item: FileItem) {
    if (!item) {
      return;
    }

    if (path.extname(item.resourceUri.fsPath).toLowerCase() !== '.yaml') {
      vscode.window.showInformationMessage(
        'Only YAML files can be added as agents.',
      );
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Validating agent YAML...',
        },
        () => validateYamlAndPromptAdd(item.resourceUri.fsPath, true, false),
      );
    } catch (err) {
      await showLoggedErrorMessage(
        CHANNEL,
        'Failed to add agent to configuration',
        err,
      );
    }
  }
}
