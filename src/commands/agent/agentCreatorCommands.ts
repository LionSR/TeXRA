// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as nunjucks from 'nunjucks';
import * as yaml from 'yaml';
import { z } from 'zod';

// Local imports - agent runtime
import { getBaseName, getMultipleName } from '@agent/index';
import {
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
  AgentPromptSchema,
} from '@agent/core/AgentDataclass';
import { createHelperModelKit } from '@agent/runtime/helperModel';
import { validateAgentYamlContent } from '@agent/runtime/agentLoad';
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import { agentDirectories, promptToAddAgentToConfig } from '@frontend/agents';
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

// ============================================================
// Tool presets for tool-use agents
// ============================================================

interface ToolGroup {
  description: string;
  tools: string[];
}

/** Categorized tool groups for guided tool-use agent creation. */
const TOOL_GROUPS: Record<string, ToolGroup> = {
  'File Operations': {
    description: 'Read, write, edit, search files and run shell commands',
    tools: [
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'ls',
    ],
  },
  'Web & Search': {
    description: 'Search the web and fetch page content',
    tools: ['web_search', 'web_fetch'],
  },
  'Academic Research': {
    description: 'Search arXiv, CrossRef, and download papers',
    tools: [
      'arxiv_search',
      'arxiv_metadata',
      'download_arxiv_source',
      'crossref_search',
      'crossref_doi',
    ],
  },
  'LaTeX Processing': {
    description: 'Extract figures, bibliography, TikZ, and count words',
    tools: [
      'extract_figures',
      'extract_bib_entries',
      'extract_tikz_figures',
      'texcount',
    ],
  },
  'Citation Management': {
    description: 'Manage references with Zotero',
    tools: ['zotero_add', 'zotero_search', 'zotero_export'],
  },
  Computation: {
    description: 'Mathematical computation with Wolfram Alpha',
    tools: ['wolfram'],
  },
  'Agent Delegation': {
    description: 'Delegate tasks to other agents and manage executions',
    tools: [
      'delegate_workflow',
      'delegate_agent',
      'executions',
      'accept_run_files',
    ],
  },
  'Lean 4': {
    description: 'Lean 4 proof assistant integration',
    tools: [
      'lean_diagnostics',
      'lean_file',
      'lean_project',
      'lean_inspect',
      'lean_loogle',
    ],
  },
  Utility: {
    description: 'Memory, todo tracking, and diagnostics',
    tools: ['memory', 'todo_write', 'diagnostics'],
  },
};

// ============================================================
// Workflow mode presets
// ============================================================

interface WorkflowMode {
  label: string;
  description: string;
  detail: string;
  temperature: number;
  rounds: number;
  isRewrite: boolean;
}

const WORKFLOW_MODES: WorkflowMode[] = [
  {
    label: 'Precise Editing',
    description: 'For fixing, correcting, and refining existing documents',
    detail: 'temperature: 0.1 | rounds: 2 | isRewrite: true',
    temperature: 0.1,
    rounds: 2,
    isRewrite: true,
  },
  {
    label: 'Creative Writing',
    description: 'For drafting and generating new content',
    detail: 'temperature: 0.8 | rounds: 2 | isRewrite: false',
    temperature: 0.8,
    rounds: 2,
    isRewrite: false,
  },
  {
    label: 'Quick Fix',
    description: 'Single-pass correction for simple changes',
    detail: 'temperature: 0.1 | rounds: 1 | isRewrite: true',
    temperature: 0.1,
    rounds: 1,
    isRewrite: true,
  },
];

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
    const categoryLabel = category === 'toolUse' ? 'Tool Use' : 'Workflow';

    const agentName = await vscode.window.showInputBox({
      title: `New ${categoryLabel} Agent`,
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
      title: `New ${categoryLabel} Agent: ${agentName}`,
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

// ============================================================
// Workflow agent creation
// ============================================================

async function createWorkflowAgent(
  config: CreatorConfig,
  agentName: string,
  description: string,
) {
  // Step 1: Pick workflow mode
  const modeItems: vscode.QuickPickItem[] = WORKFLOW_MODES.map((m) => ({
    label: m.label,
    description: m.description,
    detail: m.detail,
  }));
  const selectedMode = await vscode.window.showQuickPick(modeItems, {
    title: `Workflow Agent: ${agentName}`,
    placeHolder: 'Select a workflow mode',
  });
  if (!selectedMode) {
    return;
  }
  const mode = WORKFLOW_MODES.find((m) => m.label === selectedMode.label)!;

  // Step 2: Single vs multiple output
  const outputItems: vscode.QuickPickItem[] = [
    {
      label: 'Single output file',
      description: 'Agent produces one document',
    },
    {
      label: 'Multiple output files',
      description: 'Agent produces several documents at once',
    },
  ];
  const outputChoice = await vscode.window.showQuickPick(outputItems, {
    title: `Workflow Agent: ${agentName}`,
    placeHolder: 'Choose the agent output style',
  });
  if (!outputChoice) {
    return;
  }

  const isMultipleOutput = outputChoice.label === 'Multiple output files';

  let outputFilesYaml = '';
  let outputFilesNote = '';
  if (isMultipleOutput) {
    const filesInput = await vscode.window.showInputBox({
      title: `Workflow Agent: ${agentName}`,
      prompt: 'Enter default output filenames (comma separated)',
    });
    if (!filesInput) {
      return;
    }
    const files = filesInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    outputFilesYaml = files.map((f) => `- ${f}`).join('\n    ');
    outputFilesNote = files.map((f) => `    - ${f}`).join('\n');
  }

  const targetDir = await agentDirectories.custom();
  const filePath = vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`));
  const prefillsYaml = Array.from({ length: mode.rounds }, () => '<scratchpad>')
    .map((p) => `"${p}"`)
    .join(', ');

  const multipleNote = isMultipleOutput
    ? [
        'IMPORTANT: This agent must handle MULTIPLE output files. Adjust the structure above:',
        '- Set isMultipleOutput: true',
        '- Use documentTag: "latex_documents" (plural) and endTag: "</latex_documents>"',
        '- Add defaultOutputFiles with the file list below',
        '- In userRequest, instruct the model to wrap each file in <latex_documents> with <document name="..."> blocks',
        '- Reference {{ OUTPUT_FILES_ORDER }} for the expected output order',
        'Default output files:',
        outputFilesNote,
      ].join('\n')
    : '';

  const vars = {
    AGENT_NAME: agentName,
    DESCRIPTION: description,
    WORKFLOW_MODE: mode.label,
    TEMPERATURE: String(mode.temperature),
    ROUNDS: String(mode.rounds),
    IS_REWRITE: String(mode.isRewrite),
    PREFILLS: prefillsYaml,
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
      TEMPERATURE: String(mode.temperature),
      ROUNDS: String(mode.rounds),
      IS_REWRITE: String(mode.isRewrite),
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

// ============================================================
// Tool-use agent creation
// ============================================================

/** Present multi-select quick pick for tool groups, return flat list of selected tool names. */
async function pickToolGroups(
  agentName: string,
): Promise<string[] | undefined> {
  const items: vscode.QuickPickItem[] = Object.entries(TOOL_GROUPS).map(
    ([label, group]) => ({
      label,
      description: group.description,
      detail: group.tools.join(', '),
      picked: label === 'File Operations',
    }),
  );

  const selected = await vscode.window.showQuickPick(items, {
    title: `Tool Use Agent: ${agentName}`,
    placeHolder: 'Select tool groups for this agent',
    canPickMany: true,
  });
  if (!selected || selected.length === 0) {
    return undefined;
  }

  const tools: string[] = [];
  for (const item of selected) {
    const group = TOOL_GROUPS[item.label];
    if (group) {
      tools.push(...group.tools);
    }
  }
  return tools;
}

async function createToolUseAgent(
  config: CreatorConfig,
  agentName: string,
  description: string,
) {
  // Step 1: Pick tool groups
  const selectedTools = await pickToolGroups(agentName);
  if (!selectedTools) {
    return;
  }

  // Step 2: Pick temperature
  const tempItems: vscode.QuickPickItem[] = [
    {
      label: 'Precise (0.3)',
      description: 'Deterministic, focused tool calls',
      detail: 'Best for file editing, code generation, structured tasks',
    },
    {
      label: 'Balanced (0.7)',
      description: 'Good mix of creativity and reliability',
      detail: 'Best for research, exploration, general-purpose tasks',
    },
    {
      label: 'Creative (1.0)',
      description: 'More varied and exploratory responses',
      detail: 'Best for brainstorming, open-ended research',
    },
  ];
  const tempChoice = await vscode.window.showQuickPick(tempItems, {
    title: `Tool Use Agent: ${agentName}`,
    placeHolder: 'Select the agent temperature',
  });
  if (!tempChoice) {
    return;
  }
  const temperature = tempChoice.label.includes('0.3')
    ? '0.3'
    : tempChoice.label.includes('0.7')
      ? '0.7'
      : '1.0';

  const toolsYaml = selectedTools.map((t) => `    - ${t}`).join('\n');
  const selectedGroupNames = Object.entries(TOOL_GROUPS)
    .filter(([, group]) => group.tools.some((t) => selectedTools.includes(t)))
    .map(([name]) => name);

  const targetDir = await agentDirectories.custom();
  const filePath = vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`));
  const vars = {
    AGENT_NAME: agentName,
    DESCRIPTION: description,
    SELECTED_TOOLS: selectedTools.join(', '),
    SELECTED_GROUPS: selectedGroupNames.join(', '),
    TEMPERATURE: temperature,
  };
  let yamlContent = await tryAIGeneration(config, 'toolUse', vars);

  if (!yamlContent) {
    yamlContent = renderFallbackTemplate(config.templates.toolUse, {
      AGENT_NAME: agentName,
      DESCRIPTION: description,
      TOOLS_YAML: toolsYaml,
      TEMPERATURE: temperature,
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
    const kit = await createHelperModelKit();
    if (!kit) {
      logger.error(CHANNEL, 'Helper model not available for agent creation');
      return undefined;
    }
    const { handler, client } = kit;

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
        systemPrompt,
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
