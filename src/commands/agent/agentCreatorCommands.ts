// Standard library imports
import * as path from 'path';

// Third-party imports
import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import * as nunjucks from 'nunjucks';
import * as yaml from 'yaml';
import { z } from 'zod';

// Local imports - agent runtime
import { ANTHROPIC_MODELS } from 'llm-zoo';
import { getBaseName, getMultipleName } from '@agent/index';
import {
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
  AgentPromptSchema,
} from '@agent/core/AgentDataclass';
import { validateAgentYamlContent } from '@agent/runtime/agentLoad';
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import { SecretManager } from '@frontend/secretManager';
import { agentDirectories, promptToAddAgentToConfig } from '@frontend/agents';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

// Type imports
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

const CHANNEL = 'AgentCreator';
logger.initialize(CHANNEL);

export const agentCreatorCommands = {
  createAgentWithAI: 'texra.createAgentWithAI',
};

interface CreatorConfig {
  prompts: {
    systemPrompt: string;
    userRequest: string;
    systemPromptToolUse: string;
    userRequestToolUse: string;
    retryPrompt: string;
  };
  templates: { workflowSingle: string; workflowMultiple: string; toolUse: string };
}

const nunjucksEnv = nunjucks.configure({ autoescape: false });

// ============================================================
// Schema reference generation
// ============================================================

/** Cached schema reference, generated once from Zod schemas. */
let schemaRefCache: Record<'workflow' | 'toolUse', string> | null = null;

/** Build a JSON Schema string for the given agent category's settings + prompts. */
function getSchemaReference(category: 'workflow' | 'toolUse'): string {
  if (!schemaRefCache) {
    schemaRefCache = {
      workflow: buildSchemaRef(AgentWorkflowSettingSchema),
      toolUse: buildSchemaRef(AgentToolUseSettingSchema),
    };
  }
  return schemaRefCache[category];
}

function buildSchemaRef(settingsSchema: z.ZodObject<z.ZodRawShape>): string {
  return [
    '## Agent YAML Schema (JSON Schema)',
    '',
    '### settings',
    JSON.stringify(z.toJSONSchema(settingsSchema), null, 2),
    '',
    '### prompts',
    JSON.stringify(z.toJSONSchema(AgentPromptSchema), null, 2),
  ].join('\n');
}

// ============================================================
// Config loading
// ============================================================

/** Cached creator config loaded from resources/templates/ */
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
  const [mainYaml, workflowSingle, workflowMultiple, toolUse] =
    await Promise.all([
      AbsoluteFS.read(path.join(templatesDir, 'agentCreator.yaml')),
      AbsoluteFS.read(
        path.join(templatesDir, 'agentTemplate-workflowSingle.yaml'),
      ),
      AbsoluteFS.read(
        path.join(templatesDir, 'agentTemplate-workflowMultiple.yaml'),
      ),
      AbsoluteFS.read(path.join(templatesDir, 'agentTemplate-toolUse.yaml')),
    ]);
  const parsed = yaml.parse(mainYaml) as Omit<CreatorConfig, 'templates'>;
  creatorConfig = {
    ...parsed,
    templates: { workflowSingle, workflowMultiple, toolUse },
  };
  return creatorConfig;
}

function validateAgentYamlString(content: string): string | null {
  try {
    validateAgentYamlContent(content);
    return null;
  } catch (err) {
    return toErrorMessage(err);
  }
}

// ============================================================
// Command registration and handlers
// ============================================================

export function registerAgentCreatorCommands(
  context: vscode.ExtensionContext,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      agentCreatorCommands.createAgentWithAI,
      (category?: 'workflow' | 'toolUse') =>
        handleCreateAgentWithAI(context, category ?? 'workflow'),
    ),
  );
  return agentCreatorCommands;
}

async function handleCreateAgentWithAI(
  context: vscode.ExtensionContext,
  category: 'workflow' | 'toolUse',
) {
  try {
    const config = await loadCreatorConfig(context);

    const agentName = await vscode.window.showInputBox({
      prompt: 'Enter a name for the new agent (without .yaml)',
      validateInput: (value) =>
        !value || /[^a-zA-Z0-9_-]/.test(value)
          ? 'Use letters, numbers, underscore or dash'
          : null,
    });
    if (!agentName) {
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: 'Briefly describe what this agent should do',
    });
    if (!description) {
      return;
    }

    if (category === 'toolUse') {
      await createToolUseAgent(config, agentName, description);
    } else {
      await createWorkflowAgent(config, agentName, description);
    }
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to create agent', err);
  }
}

async function createWorkflowAgent(
  config: CreatorConfig,
  agentName: string,
  description: string,
) {
  const outputChoice = await vscode.window.showQuickPick(
    ['Single output file', 'Multiple output files'],
    { placeHolder: 'Choose the agent output style' },
  );
  if (!outputChoice) {
    return;
  }

  let outputFilesYaml = '';
  if (outputChoice === 'Multiple output files') {
    const filesInput = await vscode.window.showInputBox({
      prompt: 'Enter default output filenames (comma separated)',
    });
    if (!filesInput) {
      return;
    }
    const files = filesInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    outputFilesYaml = files.map((f) => `    - ${f}`).join('\n');
  }

  const targetDir = await agentDirectories.custom();
  const filePath = vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`));

  const vars = { AGENT_NAME: agentName, DESCRIPTION: description };
  let yamlContent = await tryAIGeneration(config, 'workflow', vars);

  if (!yamlContent) {
    const template =
      outputChoice === 'Multiple output files'
        ? config.templates.workflowMultiple
        : config.templates.workflowSingle;
    yamlContent = template
      .replaceAll('{{ AGENT_NAME }}', agentName)
      .replaceAll('{{ DESCRIPTION }}', description)
      .replaceAll('{{ OUTPUT_FILES }}', outputFilesYaml);
  }

  const isMultipleOutput = outputChoice === 'Multiple output files';
  const configOptions = isMultipleOutput
    ? {
        isMultipleOutput: true as const,
        baseAgentName: getBaseName(agentName),
        multipleAgentName: agentName,
      }
    : {
        isMultipleOutput: false as const,
        multipleAgentName: getMultipleName(agentName),
      };
  await writeAndRegisterAgent(filePath, yamlContent, agentName, configOptions);
}

async function createToolUseAgent(
  config: CreatorConfig,
  agentName: string,
  description: string,
) {
  const targetDir = await agentDirectories.custom();
  const filePath = vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`));

  const vars = { AGENT_NAME: agentName, DESCRIPTION: description };
  let yamlContent = await tryAIGeneration(config, 'toolUse', vars);

  if (!yamlContent) {
    yamlContent = config.templates.toolUse
      .replaceAll('{{ AGENT_NAME }}', agentName)
      .replaceAll('{{ DESCRIPTION }}', description);
  }

  await writeAndRegisterAgent(filePath, yamlContent, agentName, {}, 'toolUse');
}

async function writeAndRegisterAgent(
  filePath: vscode.Uri,
  yamlContent: string,
  agentName: string,
  configOptions: Parameters<typeof promptToAddAgentToConfig>[2] = {},
  category: 'workflow' | 'toolUse' = 'workflow',
): Promise<void> {
  await AbsoluteFS.write(filePath.fsPath, yamlContent);
  vscode.window.showInformationMessage(`Created agent at ${filePath.fsPath}`);
  await promptToAddAgentToConfig(agentName, false, configOptions, category);
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}

// ============================================================
// AI generation
// ============================================================

async function tryAIGeneration(
  config: CreatorConfig,
  category: 'workflow' | 'toolUse',
  vars: Record<string, string>,
): Promise<string | undefined> {
  try {
    const apiKey = await SecretManager.getApiKey('anthropic');
    const anthropic = new Anthropic({ apiKey });

    const schemaRef = getSchemaReference(category);
    const systemTemplate =
      category === 'toolUse'
        ? config.prompts.systemPromptToolUse
        : config.prompts.systemPrompt;
    const systemPrompt =
      nunjucksEnv.renderString(systemTemplate, vars) + '\n' + schemaRef;

    const userRequestTemplate =
      category === 'toolUse'
        ? config.prompts.userRequestToolUse
        : config.prompts.userRequest;
    const baseUserRequest = nunjucksEnv.renderString(
      userRequestTemplate,
      vars,
    );

    let userMessage = baseUserRequest;
    for (let attempt = 0; attempt < 2; attempt++) {
      const params: MessageCreateParams = {
        model: ANTHROPIC_MODELS.opus41.fullName,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 2048,
      };
      const response = await anthropic.messages.create(params);
      const firstContent = response.content[0];
      if (firstContent?.type === 'text') {
        const text = firstContent.text.trim();
        const match = text.match(/<yaml>([\s\S]*?)<\/yaml>/i);
        const candidate = match ? match[1].trim() : text;
        const validationErr = validateAgentYamlString(candidate);
        if (!validationErr) {
          return candidate;
        }

        const options =
          attempt === 0
            ? (['Try Again', 'Use Template'] as const)
            : (['Use Template'] as const);
        const choice = await vscode.window.showWarningMessage(
          `Generated YAML was invalid: ${validationErr}`,
          ...options,
        );
        if (choice === 'Try Again' && attempt === 0) {
          userMessage =
            baseUserRequest +
            '\n' +
            nunjucksEnv.renderString(config.prompts.retryPrompt, {
              VALIDATION_ERROR: validationErr,
            });
          continue;
        }
        break;
      }
    }
  } catch (err) {
    logger.error(CHANNEL, `AI generation failed: ${toErrorMessage(err)}`);
  }
  return undefined;
}
