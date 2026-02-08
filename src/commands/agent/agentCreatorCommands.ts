// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as nunjucks from 'nunjucks';
import * as yaml from 'yaml';
import { z } from 'zod';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - agent runtime
import { getBaseName, getMultipleName } from '@agent/index';
import {
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
  AgentPromptSchema,
} from '@agent/core/AgentDataclass';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { validateAgentYamlContent } from '@agent/runtime/agentLoad';
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import { globalSM, GlobalStateKey } from '@common/state';
import { agentDirectories, promptToAddAgentToConfig } from '@frontend/agents';
import { DEFAULT_POLISH_MODEL } from '@shared/constants/providers';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';
import { isNonEmptyString } from '@utils/core/stringCore';
import { extractTextFromTag } from '@utils/text/xmlExtraction';

const CHANNEL = 'AgentCreator';
logger.initialize(CHANNEL);

export const agentCreatorCommands = {
  createAgentWithAI: 'texra.createAgentWithAI',
};

interface AgentPromptPair {
  systemPrompt: string;
  userRequest: string;
}

interface CreatorConfig {
  workflow: AgentPromptPair;
  toolUse: AgentPromptPair;
  retryPrompts: Record<'workflow' | 'toolUse', string>;
  templates: {
    workflowSingle: string;
    workflowMultiple: string;
    toolUse: string;
  };
}

const nunjucksEnv = nunjucks.configure({ autoescape: false });

/** Runtime variables that must pass through Nunjucks unchanged in fallback templates. */
const RUNTIME_PASSTHROUGH = Object.fromEntries(
  [
    'INPUT_CONTENT',
    'INPUT_FILE',
    'ALL_INPUTS',
    'ALL_AUXILIARYS',
    'ALL_REFERENCES',
    'ADDITIONAL_INPUTS',
    'INSTRUCTION',
    'REFERENCE_CONTENT',
    'AUXILIARY_CONTENT',
    'OUTPUT_FILES_ORDER',
  ].map((v) => [v, `{{ ${v} }}`]),
);

function renderFallbackTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  try {
    return nunjucksEnv.renderString(template, {
      ...RUNTIME_PASSTHROUGH,
      ...vars,
    });
  } catch (err) {
    throw new Error(
      `Failed to render fallback template: ${toErrorMessage(err)}`,
    );
  }
}

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

interface ParsedCreatorYaml {
  prompts: { systemPrompt: string; userRequest: string; retryPrompt?: string };
}

async function loadCreatorConfig(
  context: vscode.ExtensionContext,
): Promise<CreatorConfig> {
  if (creatorConfig) return creatorConfig;
  const templatesDir = path.join(
    context.extensionPath,
    'resources',
    'templates',
  );
  const [
    workflowYaml,
    toolUseYaml,
    workflowSingle,
    workflowMultiple,
    toolUseTpl,
  ] = await Promise.all([
    AbsoluteFS.read(path.join(templatesDir, 'agentCreatorWorkflow.yaml')),
    AbsoluteFS.read(path.join(templatesDir, 'agentCreatorToolUse.yaml')),
    AbsoluteFS.read(
      path.join(templatesDir, 'agentTemplate-workflowSingle.yaml'),
    ),
    AbsoluteFS.read(
      path.join(templatesDir, 'agentTemplate-workflowMultiple.yaml'),
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
    templates: { workflowSingle, workflowMultiple, toolUse: toolUseTpl },
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

export function registerAgentCreatorCommands(context: vscode.ExtensionContext) {
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

async function resolveAgentFilePath(agentName: string): Promise<vscode.Uri> {
  const targetDir = await agentDirectories.custom();
  return vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`));
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

  const isMultipleOutput = outputChoice === 'Multiple output files';

  let outputFilesYaml = '';
  if (isMultipleOutput) {
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

  const filePath = await resolveAgentFilePath(agentName);
  const multipleNote = isMultipleOutput
    ? [
        'IMPORTANT: This agent must handle MULTIPLE output files. Adjust the structure above:',
        '- Set isMultipleOutput: true',
        '- Use documentTag: "latex_documents" (plural) and endTag: "</latex_documents>"',
        '- Add defaultOutputFiles with the file list below',
        '- In userRequest, instruct the model to wrap each file in <latex_documents> with <document name="..."> blocks',
        '- Reference {{ OUTPUT_FILES_ORDER }} for the expected output order',
        'Default output files:',
        outputFilesYaml,
      ].join('\n')
    : '';
  const vars = {
    AGENT_NAME: agentName,
    DESCRIPTION: description,
    MULTIPLE_OUTPUT_NOTE: multipleNote,
  };
  let yamlContent = await tryAIGeneration(config, 'workflow', vars);

  if (!yamlContent) {
    const template = isMultipleOutput
      ? config.templates.workflowMultiple
      : config.templates.workflowSingle;
    yamlContent = renderFallbackTemplate(template, {
      AGENT_NAME: agentName,
      DESCRIPTION: description,
      OUTPUT_FILES: outputFilesYaml,
    });
  }

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
  const filePath = await resolveAgentFilePath(agentName);
  const vars = { AGENT_NAME: agentName, DESCRIPTION: description };
  let yamlContent = await tryAIGeneration(config, 'toolUse', vars);

  if (!yamlContent) {
    yamlContent = renderFallbackTemplate(config.templates.toolUse, {
      AGENT_NAME: agentName,
      DESCRIPTION: description,
    });
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
    // Resolve model (reuse the polish model setting)
    const configuredModel = globalSM.get<string>(
      GlobalStateKey.POLISH_MODEL,
      DEFAULT_POLISH_MODEL,
    );
    const modelName = isNonEmptyString(configuredModel)
      ? configuredModel.trim()
      : DEFAULT_POLISH_MODEL;
    const modelConfig = MODEL_CONFIGS[modelName];
    if (!modelConfig) {
      logger.error(CHANNEL, `Unknown model "${modelName}" for agent creation`);
      return undefined;
    }

    const handler = createModelHandler(modelConfig);
    handler.setOutputStreaming(false);
    handler.setProgressViewEnabled(false);
    const client = await handler.getClient();

    // Build prompts – include RUNTIME_PASSTHROUGH so that template variable
    // references like {{ INPUT_FILE }} in the creator prompts survive Nunjucks
    // rendering as literal text for the AI to see.
    const prompts = config[category];
    const schemaRef = getSchemaReference(category);
    const renderVars = { ...RUNTIME_PASSTHROUGH, ...vars };
    const systemPrompt =
      nunjucksEnv.renderString(prompts.systemPrompt, renderVars) +
      '\n' +
      schemaRef;
    const baseUserRequest = nunjucksEnv.renderString(
      prompts.userRequest,
      renderVars,
    );

    let userMessage = baseUserRequest;
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = await handler.initializeMessages(
        '',
        userMessage,
        undefined,
        systemPrompt,
      );
      const result = await handler.createResponse({
        client,
        messages,
        temperature: 0,
      });
      const { text } = handler.extractResponse(result.response, '');

      if (isNonEmptyString(text)) {
        const extracted = extractTextFromTag(text, 'yaml');
        const candidate = (extracted || text).trim();
        const validationErr = validateAgentYamlString(candidate);
        if (!validationErr) {
          logger.info(CHANNEL, `AI generation succeeded for ${category} agent`);
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
            nunjucksEnv.renderString(config.retryPrompts[category], {
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
