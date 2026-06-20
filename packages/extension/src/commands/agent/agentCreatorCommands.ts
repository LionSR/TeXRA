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
      const selected = await vscode.window.showQuickPick(
        Object.entries(TOOL_GROUPS).map(([label, group]) => ({
          label,
          description: group.description,
          detail: group.tools.join(', '),
          picked: suggested.has(label),
        })),
        {
          title: `Tool Use Agent: ${agentName}`,
          placeHolder:
            'Select tool groups (pre-selected based on your description)',
          canPickMany: true,
        },
      );
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
