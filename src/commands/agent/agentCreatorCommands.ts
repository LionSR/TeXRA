// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as nunjucks from 'nunjucks';
import * as yaml from 'yaml';
import { z } from 'zod';

// Local imports - agent runtime
import { getBaseName, getMultipleName } from '@agent/index';
import { Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
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

// ============================================================
// Types
// ============================================================

type AgentCategory = 'workflow' | 'toolUse';

interface AgentPromptPair {
  systemPrompt: string;
  userRequest: string;
}

interface CreatorConfig {
  workflow: AgentPromptPair;
  toolUse: AgentPromptPair;
  retryPrompts: Record<AgentCategory, string>;
  templates: {
    workflowSingle: string;
    workflowMultiple: string;
    toolUse: string;
  };
}

/** Everything needed to generate and register an agent. */
interface AgentBlueprint {
  category: AgentCategory;
  agentName: string;
  filePath: vscode.Uri;
  aiVars: Record<string, string>;
  fallbackTemplate: string;
  fallbackVars: Record<string, string>;
  registrationMeta: Parameters<typeof promptToAddAgentToConfig>[2];
}

/** Mutable shared state flowing through the agent creation PocketFlow. */
interface AgentCreatorShared {
  config: CreatorConfig;
  category: AgentCategory;
  agentName?: string;
  description?: string;
  blueprint?: AgentBlueprint;
}

// ============================================================
// Runtime variable passthrough (protects {{ }} from Nunjucks)
// ============================================================

/** Tool-use agents only receive the user instruction — they access files via tools. */
const TOOL_USE_VARS = ['INSTRUCTION'];

/** Workflow agents receive pre-loaded file content and document structure variables. */
const WORKFLOW_VARS = [
  'INPUT_FILE',
  'INPUT_CONTENT',
  'ALL_INPUTS',
  'ALL_AUXILIARYS',
  'ALL_REFERENCES',
  'ADDITIONAL_INPUTS',
  'INSTRUCTION',
  'REFERENCE_CONTENT',
  'AUXILIARY_CONTENT',
  'OUTPUT_FILES_ORDER',
];

function buildPassthrough(vars: string[]): Record<string, string> {
  return Object.fromEntries(vars.map((v) => [v, `{{ ${v} }}`]));
}

const PASSTHROUGH: Record<AgentCategory, Record<string, string>> = {
  toolUse: buildPassthrough(TOOL_USE_VARS),
  workflow: buildPassthrough(WORKFLOW_VARS),
};

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

// ============================================================
// Infrastructure: Nunjucks, schema refs, config loading
// ============================================================

const nunjucksEnv = nunjucks.configure({ autoescape: false });

function renderFallbackTemplate(
  category: AgentCategory,
  template: string,
  vars: Record<string, string>,
): string {
  try {
    return nunjucksEnv.renderString(template, {
      ...PASSTHROUGH[category],
      ...vars,
    });
  } catch (err) {
    throw new Error(
      `Failed to render fallback template: ${toErrorMessage(err)}`,
    );
  }
}

/** Cached schema reference, generated once from Zod schemas. */
let schemaRefCache: Record<AgentCategory, string> | null = null;

function getSchemaReference(category: AgentCategory): string {
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
// Helpers used by nodes
// ============================================================

const DESCRIPTION_PROMPTS: Record<AgentCategory, string> = {
  toolUse:
    'What should this agent do? Mention capabilities it needs (e.g., search papers, edit files, browse the web)',
  workflow:
    'What should this agent do? Mention whether it rewrites existing documents or creates new ones',
};

function buildMultipleOutputNote(outputFilesNote: string): string {
  return [
    'IMPORTANT: This agent must handle MULTIPLE output files. Adjust the structure above:',
    '- Set isMultipleOutput: true',
    '- Use documentTag: "latex_documents" (plural) and endTag: "</latex_documents>"',
    '- Add defaultOutputFiles with the file list below',
    '- In userRequest, instruct the model to wrap each file in <latex_documents> with <document name="..."> blocks',
    '- Reference {{ OUTPUT_FILES_ORDER }} for the expected output order',
    'Default output files:',
    outputFilesNote,
  ].join('\n');
}

async function pickTools(
  agentName: string,
  description: string,
): Promise<{ tools: string[]; groups: string[] } | undefined> {
  const suggested = suggestToolGroups(description);

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
}

async function tryAIGeneration(
  config: CreatorConfig,
  category: AgentCategory,
  vars: Record<string, string>,
): Promise<string | undefined> {
  try {
    const kit = await createHelperModelKit();
    if (!kit) {
      logger.error(CHANNEL, 'Helper model not available for agent creation');
      return undefined;
    }
    const { handler, client } = kit;

    const prompts = config[category];
    const schemaRef = getSchemaReference(category);
    const renderVars = { ...PASSTHROUGH[category], ...vars };
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

// ============================================================
// PocketFlow nodes
// ============================================================

/**
 * Node 1: Gather common input (agent name + description).
 * Returns the category as the transition action to branch the flow.
 * Returns 'cancel' (no successor) if the user dismisses any prompt.
 */
class GatherInputNode extends Node<AgentCreatorShared> {
  async prep(shared: AgentCreatorShared) {
    return {
      category: shared.category,
      categoryLabel: shared.category === 'toolUse' ? 'Tool Use' : 'Workflow',
    };
  }

  async exec(prepRes: { category: AgentCategory; categoryLabel: string }) {
    const agentName = await vscode.window.showInputBox({
      title: `New ${prepRes.categoryLabel} Agent`,
      prompt: 'Enter a name for the new agent (without .yaml)',
      validateInput: (value) =>
        !value || /[^a-zA-Z0-9_-]/.test(value)
          ? 'Use letters, numbers, underscore or dash'
          : null,
    });
    if (!agentName) return undefined;

    const description = await vscode.window.showInputBox({
      title: `New ${prepRes.categoryLabel} Agent: ${agentName}`,
      prompt: DESCRIPTION_PROMPTS[prepRes.category],
    });
    if (!description) return undefined;

    return { agentName, description };
  }

  async post(
    shared: AgentCreatorShared,
    _prepRes: unknown,
    execRes: { agentName: string; description: string } | undefined,
  ): Promise<string | undefined> {
    if (!execRes) return 'cancel';
    shared.agentName = execRes.agentName;
    shared.description = execRes.description;
    return shared.category; // 'workflow' or 'toolUse' → branches the flow
  }
}

/**
 * Node 2a: Gather workflow-specific input → AgentBlueprint.
 * Asks for output style (single vs multiple) and output filenames.
 */
class WorkflowBlueprintNode extends Node<AgentCreatorShared> {
  async prep(shared: AgentCreatorShared) {
    return {
      config: shared.config,
      agentName: shared.agentName!,
      description: shared.description!,
    };
  }

  async exec(prepRes: {
    config: CreatorConfig;
    agentName: string;
    description: string;
  }) {
    const { config, agentName, description } = prepRes;

    const outputChoice = await vscode.window.showQuickPick(
      [
        {
          label: 'Single output file',
          description: 'Agent produces one document',
        },
        {
          label: 'Multiple output files',
          description: 'Agent produces several documents at once',
        },
      ],
      {
        title: `Workflow Agent: ${agentName}`,
        placeHolder: 'Choose the agent output style',
      },
    );
    if (!outputChoice) return undefined;

    const isMultiple = outputChoice.label === 'Multiple output files';

    let outputFilesYaml = '';
    let outputFilesNote = '';
    if (isMultiple) {
      const filesInput = await vscode.window.showInputBox({
        title: `Workflow Agent: ${agentName}`,
        prompt: 'Enter default output filenames (comma separated)',
      });
      if (!filesInput) return undefined;
      const files = filesInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      outputFilesYaml = files.map((f) => `- ${f}`).join('\n    ');
      outputFilesNote = files.map((f) => `    - ${f}`).join('\n');
    }

    const targetDir = await agentDirectories.custom();
    const blueprint: AgentBlueprint = {
      category: 'workflow',
      agentName,
      filePath: vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`)),
      aiVars: {
        AGENT_NAME: agentName,
        DESCRIPTION: description,
        MULTIPLE_OUTPUT_NOTE: isMultiple
          ? buildMultipleOutputNote(outputFilesNote)
          : '',
      },
      fallbackTemplate: isMultiple
        ? config.templates.workflowMultiple
        : config.templates.workflowSingle,
      fallbackVars: {
        AGENT_NAME: agentName,
        DESCRIPTION: description,
        OUTPUT_FILES: outputFilesYaml,
      },
      registrationMeta: isMultiple
        ? {
            isMultipleOutput: true,
            baseAgentName: getBaseName(agentName),
            multipleAgentName: agentName,
          }
        : {
            isMultipleOutput: false,
            multipleAgentName: getMultipleName(agentName),
          },
    };

    return blueprint;
  }

  async post(
    shared: AgentCreatorShared,
    _prepRes: unknown,
    execRes: AgentBlueprint | undefined,
  ): Promise<string | undefined> {
    if (!execRes) return 'cancel';
    shared.blueprint = execRes;
    return FlowTransition.DEFAULT;
  }
}

/**
 * Node 2b: Gather tool-use-specific input → AgentBlueprint.
 * Shows keyword-aware tool group picker pre-selected from the description.
 */
class ToolUseBlueprintNode extends Node<AgentCreatorShared> {
  async prep(shared: AgentCreatorShared) {
    return {
      config: shared.config,
      agentName: shared.agentName!,
      description: shared.description!,
    };
  }

  async exec(prepRes: {
    config: CreatorConfig;
    agentName: string;
    description: string;
  }) {
    const { config, agentName, description } = prepRes;

    const selection = await pickTools(agentName, description);
    if (!selection) return undefined;

    const targetDir = await agentDirectories.custom();
    const blueprint: AgentBlueprint = {
      category: 'toolUse',
      agentName,
      filePath: vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`)),
      aiVars: {
        AGENT_NAME: agentName,
        DESCRIPTION: description,
        SELECTED_TOOLS: selection.tools.join(', '),
        SELECTED_GROUPS: selection.groups.join(', '),
      },
      fallbackTemplate: config.templates.toolUse,
      fallbackVars: {
        AGENT_NAME: agentName,
        DESCRIPTION: description,
        TOOLS_YAML: selection.tools.map((t) => `    - ${t}`).join('\n'),
      },
      registrationMeta: {},
    };

    return blueprint;
  }

  async post(
    shared: AgentCreatorShared,
    _prepRes: unknown,
    execRes: AgentBlueprint | undefined,
  ): Promise<string | undefined> {
    if (!execRes) return 'cancel';
    shared.blueprint = execRes;
    return FlowTransition.DEFAULT;
  }
}

/**
 * Node 3: Generate agent YAML via AI (with fallback) → write file → register.
 * exec() handles AI generation; post() writes the file and registers the agent.
 */
class GenerateAndRegisterNode extends Node<AgentCreatorShared> {
  async prep(shared: AgentCreatorShared) {
    return {
      config: shared.config,
      blueprint: shared.blueprint!,
    };
  }

  async exec(prepRes: { config: CreatorConfig; blueprint: AgentBlueprint }) {
    const { config, blueprint } = prepRes;
    let yamlContent = await tryAIGeneration(
      config,
      blueprint.category,
      blueprint.aiVars,
    );
    if (!yamlContent) {
      yamlContent = renderFallbackTemplate(
        blueprint.category,
        blueprint.fallbackTemplate,
        blueprint.fallbackVars,
      );
    }
    return yamlContent;
  }

  async post(
    _shared: AgentCreatorShared,
    prepRes: { config: CreatorConfig; blueprint: AgentBlueprint },
    yamlContent: string,
  ): Promise<string | undefined> {
    const { blueprint } = prepRes;
    await AbsoluteFS.write(blueprint.filePath.fsPath, yamlContent);
    vscode.window.showInformationMessage(
      `Created agent at ${blueprint.filePath.fsPath}`,
    );
    await promptToAddAgentToConfig(
      blueprint.agentName,
      false,
      blueprint.registrationMeta,
      blueprint.category,
    );
    const doc = await vscode.workspace.openTextDocument(blueprint.filePath);
    await vscode.window.showTextDocument(doc);
    return FlowTransition.DEFAULT;
  }
}

// ============================================================
// Flow factory and entry point
// ============================================================

function createAgentCreatorFlow(): Flow<AgentCreatorShared> {
  const gatherInput = new GatherInputNode();
  const workflowBlueprint = new WorkflowBlueprintNode();
  const toolUseBlueprint = new ToolUseBlueprintNode();
  const generateAndRegister = new GenerateAndRegisterNode();

  // Branch based on category after gathering input
  gatherInput.on('workflow', workflowBlueprint);
  gatherInput.on('toolUse', toolUseBlueprint);

  // Both blueprint paths converge to generation
  workflowBlueprint.next(generateAndRegister);
  toolUseBlueprint.next(generateAndRegister);

  // 'cancel' has no successor → flow ends silently
  return new Flow<AgentCreatorShared>(gatherInput);
}

export function registerAgentCreatorCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      agentCreatorCommands.createAgentWithAI,
      (category?: AgentCategory) =>
        handleCreateAgentWithAI(context, category ?? 'workflow'),
    ),
  );
  return agentCreatorCommands;
}

async function handleCreateAgentWithAI(
  context: vscode.ExtensionContext,
  category: AgentCategory,
) {
  try {
    const config = await loadCreatorConfig(context);
    const shared: AgentCreatorShared = { config, category };
    const flow = createAgentCreatorFlow();
    await flow.run(shared);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to create agent', err);
  }
}
