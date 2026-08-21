import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  type AgentCreatorUI,
  type CreatorConfig,
  TOOL_GROUPS,
  buildCreatorConfig,
  runAgentCreator,
} from '@agent/implementations/agentCreator/agentCreatorFlow';
import { renderAgentTemplateString } from '@agent/templates/agentTemplateRenderer';
import { settleQuickInput } from '@commands/_shared/quickInputUtils';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { promptToAddAgentToConfig } from '@frontend/agents/register';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { AgentCategory } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const CHANNEL = 'AgentCreator';

/** Cached after first load. Templates are bundled resources — stable for the session. */
let creatorConfig: CreatorConfig | null = null;

async function loadCreatorConfig(
  context: vscode.ExtensionContext,
): Promise<CreatorConfig> {
  if (creatorConfig) return creatorConfig;
  const templatesDir = path.join(
    context.extensionPath,
    'resources',
    'templates',
  );
  const [workflowYaml, toolUseYaml, workflowSingle, toolUseTpl] =
    await Promise.all([
      AbsoluteFS.read(path.join(templatesDir, 'agentCreatorWorkflow.yaml')),
      AbsoluteFS.read(path.join(templatesDir, 'agentCreatorToolUse.yaml')),
      AbsoluteFS.read(
        path.join(templatesDir, 'agentTemplate-workflowSingle.yaml'),
      ),
      AbsoluteFS.read(path.join(templatesDir, 'agentTemplate-toolUse.yaml')),
    ]);
  creatorConfig = buildCreatorConfig({
    workflowYaml,
    toolUseYaml,
    workflowSingle,
    toolUseTpl,
  });
  return creatorConfig;
}

/**
 * Multi-select tool-group picker with a persistent prompt hint and a native
 * "Select all / Clear" toggle button on top of the stateful multi-select.
 */
async function pickToolGroups(
  agentName: string,
  items: vscode.QuickPickItem[],
): Promise<readonly vscode.QuickPickItem[] | undefined> {
  const qp = vscode.window.createQuickPick();
  qp.title = `Tool Use Agent: ${agentName}`;
  qp.placeholder = 'Select tool groups';
  qp.canSelectMany = true;
  qp.items = items;
  const initiallySelected = items.filter((item) => item.picked);
  qp.selectedItems = initiallySelected;
  qp.prompt =
    'Space / click to toggle. Pre-selected groups match your description.';

  let allSelected =
    initiallySelected.length > 0 && initiallySelected.length === items.length;
  let activeSelectAllButton: vscode.QuickInputButton | undefined;
  const refreshSelectAllButton = () => {
    activeSelectAllButton = {
      iconPath: new vscode.ThemeIcon('check-all'),
      tooltip: 'Select all / clear',
      location: vscode.QuickInputButtonLocation?.Input,
      toggle: { checked: allSelected },
    };
    qp.buttons = [activeSelectAllButton];
  };
  refreshSelectAllButton();
  qp.onDidChangeSelection((selected) => {
    allSelected = selected.length > 0 && selected.length === qp.items.length;
    refreshSelectAllButton();
  });
  qp.onDidTriggerButton((button) => {
    if (button !== activeSelectAllButton) {
      return;
    }
    allSelected = qp.items.length > 0 && !allSelected;
    qp.selectedItems = allSelected ? [...qp.items] : [];
    refreshSelectAllButton();
  });

  return settleQuickInput<readonly vscode.QuickPickItem[]>(qp, (accept) => {
    qp.onDidAccept(() => {
      accept(qp.selectedItems);
    });
  });
}

function buildVSCodeUI(): AgentCreatorUI {
  return {
    async promptAgentName(categoryLabel) {
      return vscode.window.showInputBox({
        title: `New ${categoryLabel} Agent`,
        prompt: 'Enter a name for the new agent (without .yaml)',
        validateInput: (value) =>
          !value || /[^a-zA-Z0-9_-]/.test(value)
            ? 'Use letters, numbers, underscore or dash'
            : null,
      });
    },

    async promptDescription(title, prompt) {
      return vscode.window.showInputBox({ title, prompt });
    },

    async pickTools(agentName, _description, suggestedGroups) {
      const suggested = new Set(suggestedGroups);
      const items: vscode.QuickPickItem[] = Object.entries(TOOL_GROUPS).map(
        ([label, group]) => ({
          label,
          description: group.description,
          detail: group.tools.join(', '),
          picked: suggested.has(label),
        }),
      );

      const selected = await pickToolGroups(agentName, items);
      if (!selected || selected.length === 0) return undefined;
      const tools: string[] = [];
      const groups: string[] = [];
      for (const item of selected) {
        const group = TOOL_GROUPS[item.label];
        if (group) {
          tools.push(...group.tools);
          groups.push(item.label);
        }
      }
      return { tools, groups };
    },

    async getCustomAgentDir() {
      return agentDirectories.custom();
    },

    showCreatedInfo(filePath) {
      void vscode.window.showInformationMessage(`Created agent at ${filePath}`);
    },

    async promptAddToConfig(agentName, category) {
      await promptToAddAgentToConfig(agentName, 'custom', category);
    },

    async openCreatedFile(filePath) {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(filePath),
      );
      await vscode.window.showTextDocument(doc);
    },

    renderTemplate(template, vars) {
      return renderAgentTemplateString(template, vars);
    },
  };
}

/**
 * Runs the agent-creator wizard directly rather than via `executeAgent`.
 * `executeAgent` launches YAML-defined `AgentConfig` runs (`workflow` /
 * `toolUse`) and tracks them as sessions with resume/history semantics; this
 * flow authors a *new* agent YAML and never itself becomes a trackable
 * session, so there is no `AgentConfig` to hand it and no resume state to
 * keep coherent.
 */
export async function handleCreateAgentWithAI(
  context: vscode.ExtensionContext,
  category: AgentCategory,
): Promise<void> {
  try {
    const config = await loadCreatorConfig(context);
    await runAgentCreator(config, category, buildVSCodeUI());
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to create agent', err);
  }
}
