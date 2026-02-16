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
// Tool groups for tool-use agent creation
// ============================================================

interface ToolGroup {
  description: string;
  tools: string[];
  /** Keywords in the agent description that suggest this group. */
  keywords: string[];
}

/** Categorized tool groups shown in the tool picker. */
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
    keywords: ['file', 'edit', 'code', 'write', 'read', 'script', 'shell'],
  },
  'Web & Search': {
    description: 'Search the web and fetch page content',
    tools: ['web_search', 'web_fetch'],
    keywords: ['web', 'search', 'internet', 'online', 'url', 'fetch', 'browse'],
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
    keywords: [
      'arxiv',
      'paper',
      'research',
      'literature',
      'review',
      'survey',
      'cite',
      'doi',
      'journal',
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
    keywords: [
      'latex',
      'figure',
      'tikz',
      'bibliography',
      'bib',
      'word count',
      'extract',
    ],
  },
  'Citation Management': {
    description: 'Manage references with Zotero',
    tools: ['zotero_add', 'zotero_search', 'zotero_export'],
    keywords: ['zotero', 'citation', 'reference', 'bibliography', 'endnote'],
  },
  Computation: {
    description: 'Mathematical computation with Wolfram Alpha',
    tools: ['wolfram'],
    keywords: [
      'math',
      'compute',
      'calculate',
      'wolfram',
      'symbolic',
      'equation',
    ],
  },
  'Agent Delegation': {
    description: 'Delegate tasks to other agents and manage executions',
    tools: [
      'delegate_workflow',
      'delegate_agent',
      'executions',
      'accept_run_files',
    ],
    keywords: ['delegate', 'orchestrat', 'pipeline', 'multi-agent', 'chain'],
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
    keywords: ['lean', 'proof', 'theorem', 'formal', 'verification'],
  },
  Utility: {
    description: 'Memory, todo tracking, and diagnostics',
    tools: ['memory', 'todo_write', 'diagnostics'],
    keywords: ['memory', 'todo', 'diagnostic', 'track'],
  },
};

/** Match description keywords to suggest tool groups. */
function suggestToolGroups(description: string): Set<string> {
  const lower = description.toLowerCase();
  const suggested = new Set<string>();
  // File Operations is always suggested as a baseline
  suggested.add('File Operations');
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (group.keywords.some((kw) => lower.includes(kw))) {
      suggested.add(name);
    }
  }
  return suggested;
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

    const descriptionPrompt =
      category === 'toolUse'
        ? 'What should this agent do? Mention capabilities it needs (e.g., search papers, edit files, browse the web)'
        : 'What should this agent do? Mention whether it rewrites existing documents or creates new ones';

    const description = await vscode.window.showInputBox({
      title: `New ${categoryLabel} Agent: ${agentName}`,
      prompt: descriptionPrompt,
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
  // Single vs multiple output (structural requirement)
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

// ============================================================
// Tool-use agent creation
// ============================================================

/**
 * Present a multi-select tool picker with groups pre-checked based on the
 * agent description. Returns a flat list of selected tool names.
 */
async function pickTools(
  agentName: string,
  description: string,
): Promise<{ tools: string[]; groups: string[] } | undefined> {
  const suggested = suggestToolGroups(description);

  const items: vscode.QuickPickItem[] = Object.entries(TOOL_GROUPS).map(
    ([label, group]) => ({
      label,
      description: group.description,
      detail: group.tools.join(', '),
      picked: suggested.has(label),
    }),
  );

  const selected = await vscode.window.showQuickPick(items, {
    title: `Tool Use Agent: ${agentName}`,
    placeHolder: 'Select tool groups (pre-selected based on your description)',
    canPickMany: true,
  });
  if (!selected || selected.length === 0) {
    return undefined;
  }

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
}

async function createToolUseAgent(
  config: CreatorConfig,
  agentName: string,
  description: string,
) {
  const selection = await pickTools(agentName, description);
  if (!selection) {
    return;
  }

  const toolsYaml = selection.tools.map((t) => `    - ${t}`).join('\n');
  const targetDir = await agentDirectories.custom();
  const filePath = vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`));
  const vars = {
    AGENT_NAME: agentName,
    DESCRIPTION: description,
    SELECTED_TOOLS: selection.tools.join(', '),
    SELECTED_GROUPS: selection.groups.join(', '),
  };
  let yamlContent = await tryAIGeneration(config, 'toolUse', vars);

  if (!yamlContent) {
    yamlContent = renderFallbackTemplate(config.templates.toolUse, {
      AGENT_NAME: agentName,
      DESCRIPTION: description,
      TOOLS_YAML: toolsYaml,
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
