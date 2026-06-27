import * as path from 'node:path';

import * as vscode from 'vscode';
import * as yaml from 'yaml';

import {
  type AgentCategory,
  type AgentCreatorUI,
  type CreatorConfig,
  TOOL_GROUPS,
  createAgentCreatorFlow,
} from '@agent/implementations/flows/agentCreator/agentCreatorFlow';
import { renderAgentTemplateString } from '@agent/templates/agentTemplateRenderer';
import { agentDirectories, promptToAddAgentToConfig } from '@frontend/agents';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'AgentCreator';
logger.initialize(CHANNEL);

interface ParsedCreatorYaml {
  prompts: { systemPrompt: string; userRequest: string; retryPrompt?: string };
}

type QuickInputToggleButton = vscode.QuickInputButton & {
  readonly toggle: { checked: boolean };
};

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
  const wf = yaml.parse(workflowYaml) as ParsedCreatorYaml;
  const tu = yaml.parse(toolUseYaml) as ParsedCreatorYaml;
  const defaultRetry =
    'The previous attempt failed validation: {{ VALIDATION_ERROR }}. Please fix and return only the YAML.';
  creatorConfig = {
    workflow: wf.prompts,
    toolUse: tu.prompts,
    retryPrompts: {
      workflow: wf.prompts.retryPrompt ?? defaultRetry,
      toolUse: tu.prompts.retryPrompt ?? defaultRetry,
    },
    templates: { workflowSingle, toolUse: toolUseTpl },
  };
  return creatorConfig;
}

/**
 * Multi-select tool-group picker. Adds a persistent prompt hint (VS Code
 * 1.108+) and a "Select all / Clear" toggle button (VS Code 1.109+) on top
 * of the stateful multi-select. Older hosts (incl. Cursor 1.105) silently
 * ignore the unsupported properties and render a plain `canSelectMany` picker.
 */
async function pickToolGroups(
  agentName: string,
  items: vscode.QuickPickItem[],
): Promise<readonly vscode.QuickPickItem[] | undefined> {
  return await new Promise<readonly vscode.QuickPickItem[] | undefined>(
    (resolve) => {
      const qp = vscode.window.createQuickPick();
      let settled = false;
      const finish = (
        value: readonly vscode.QuickPickItem[] | undefined,
      ): void => {
        if (settled) return;
        settled = true;
        resolve(value);
        qp.dispose();
      };
      qp.title = `Tool Use Agent: ${agentName}`;
      qp.placeholder = 'Select tool groups';
      qp.canSelectMany = true;
      qp.items = items;
      const initiallySelected = items.filter((item) => item.picked);
      qp.selectedItems = initiallySelected;
      if ('prompt' in qp) {
        (
          qp as vscode.QuickPick<vscode.QuickPickItem> & { prompt: string }
        ).prompt =
          'Space / click to toggle. Pre-selected groups match your description.';
      }

      let allSelected =
        initiallySelected.length > 0 &&
        initiallySelected.length === items.length;
      const selectAllButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('check-all'),
        tooltip: 'Select all / clear',
      };
      const refreshSelectAllButton = () => {
        if ('buttons' in qp) {
          const toggleButton: QuickInputToggleButton = {
            ...selectAllButton,
            toggle: { checked: allSelected },
          };
          qp.buttons = [toggleButton];
        }
      };
      refreshSelectAllButton();
      qp.onDidChangeSelection((selected) => {
        allSelected =
          selected.length > 0 && selected.length === qp.items.length;
        refreshSelectAllButton();
      });
      qp.onDidTriggerButton(() => {
        allSelected = qp.items.length > 0 && !allSelected;
        qp.selectedItems = allSelected ? [...qp.items] : [];
        refreshSelectAllButton();
      });

      qp.onDidAccept(() => {
        finish(qp.selectedItems);
      });
      qp.onDidHide(() => {
        finish(undefined);
      });
      qp.show();
    },
  );
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

    async pickTools(agentName, description) {
      const lower = description.toLowerCase();
      const suggested = new Set<string>(['File Operations']);
      for (const [name, group] of Object.entries(TOOL_GROUPS)) {
        if (group.keywords.some((kw) => lower.includes(kw)))
          suggested.add(name);
      }
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

    async promptAddToConfig(agentName, isEdited, category) {
      await promptToAddAgentToConfig(agentName, isEdited, category);
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

export async function handleCreateAgentWithAI(
  context: vscode.ExtensionContext,
  category: AgentCategory,
) {
  try {
    const config = await loadCreatorConfig(context);
    const flow = createAgentCreatorFlow(buildVSCodeUI());
    await flow.run({ config, category });
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to create agent', err);
  }
}
