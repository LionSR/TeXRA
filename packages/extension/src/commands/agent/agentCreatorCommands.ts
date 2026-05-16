import * as path from 'path';

import * as vscode from 'vscode';
import * as nunjucks from 'nunjucks';
import * as yaml from 'yaml';
import { z } from 'zod';

import { Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
  AgentPromptSchema,
} from '@agent/core/AgentDataclass';
import { createHelperModelKit } from '@agent/runtime/helperModel';
import { validateAgentYamlContent } from '@agent/runtime/agentLoad';
import { renderAgentTemplateString } from '@commands/agent/agentTemplateRenderer';
import { agentDirectories, promptToAddAgentToConfig } from '@frontend/agents';
import {
  showLoggedErrorMessage,
  toErrorMessage,
} from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';
import { isNonEmptyString } from '@utils/core/stringCore';
import { extractTextFromTag } from '@utils/text/xmlExtraction';

const CHANNEL = 'AgentCreator';
logger.initialize(CHANNEL);

export const agentCreatorCommands = {
  createAgentWithAI: 'texra.createAgentWithAI',
};

// ── Types & constants ───────────────────────────────────────

type AgentCategory = 'workflow' | 'toolUse';

/** Total AI generation attempts (1 initial + 1 validation retry) before template fallback. */
const AI_GENERATION_ATTEMPTS = 2;

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
    toolUse: string;
  };
}

interface AgentBlueprint {
  category: AgentCategory;
  agentName: string;
  filePath: vscode.Uri;
  aiVars: Record<string, string>;
  fallbackTemplate: string;
  fallbackVars: Record<string, string>;
}

/** Mutable shared state flowing through the agent creation flow. */
interface AgentCreatorShared {
  config: CreatorConfig;
  category: AgentCategory;
  agentName?: string;
  description?: string;
  blueprint?: AgentBlueprint;
  yamlContent?: string;
}

/** Tool-use agents only receive the user instruction — they access files via tools. */
const TOOL_USE_VARS = ['INSTRUCTION'];

/** Workflow agents receive pre-loaded file content and document structure variables. */
const WORKFLOW_VARS = [
  'INPUT_FILE',
  'INPUT_CONTENT',
  'INPUT_FILES',
  'ALL_INPUTS',
  'ALL_CONTEXTS',
  'LIST_OF_ALL_CONTEXTS',
  'ADDITIONAL_INPUTS',
  'INSTRUCTION',
  'OUTPUT_FILES',
];

function buildPassthrough(vars: string[]): Record<string, string> {
  return Object.fromEntries(vars.map((v) => [v, `{{ ${v} }}`]));
}

const PASSTHROUGH: Record<AgentCategory, Record<string, string>> = {
  toolUse: buildPassthrough(TOOL_USE_VARS),
  workflow: buildPassthrough(WORKFLOW_VARS),
};

const DESCRIPTION_PROMPTS: Record<AgentCategory, string> = {
  toolUse:
    'What should this agent do? Mention capabilities it needs (e.g., search papers, edit files, browse the web)',
  workflow:
    'What should this agent do? Mention whether it rewrites existing documents or creates new ones',
};

interface ToolGroup {
  description: string;
  tools: string[];
  keywords: string[];
}

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
    tools: ['memory', 'todo_write', 'plan', 'diagnostics'],
    keywords: ['memory', 'todo', 'plan', 'diagnostic', 'track'],
  },
};

// ── Infrastructure ──────────────────────────────────────────

/* autoescape off: templates contain Nunjucks/YAML syntax, not HTML.
 * Isolated Environment so the setting does not leak into Nunjucks' shared
 * singleton used by other renderers in the extension. */
const nunjucksEnv = new nunjucks.Environment(null, { autoescape: false });

/** Lazily built and cached for the extension host lifetime. Schemas are static. */
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

/** Cached after first load. Templates are bundled resources — stable for the session. */
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

async function pickTools(
  agentName: string,
  description: string,
): Promise<{ tools: string[]; groups: string[] } | undefined> {
  // Pre-select tool groups whose keywords appear in the description
  const lower = description.toLowerCase();
  const suggested = new Set<string>(['File Operations']);
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (group.keywords.some((kw) => lower.includes(kw))) {
      suggested.add(name);
    }
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
}

// ── Nodes ───────────────────────────────────────────────────

/**
 * Gather agent name + description. Branches on category ('workflow' | 'toolUse').
 * Returning 'cancel' (no registered successor) ends the flow.
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
    return shared.category;
  }
}

/**
 * Gather workflow output style and build the AgentBlueprint.
 * All data assembly and IO (directory resolution) happens in exec().
 */
class WorkflowBlueprintNode extends Node<AgentCreatorShared> {
  async prep(shared: AgentCreatorShared) {
    return {
      agentName: shared.agentName!,
      description: shared.description!,
      config: shared.config,
    };
  }

  async exec(prepRes: {
    agentName: string;
    description: string;
    config: CreatorConfig;
  }): Promise<AgentBlueprint | undefined> {
    const { agentName, description, config } = prepRes;

    const targetDir = await agentDirectories.custom();

    return {
      category: 'workflow',
      agentName,
      filePath: vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`)),
      aiVars: {
        AGENT_NAME: agentName,
        DESCRIPTION: description,
      },
      fallbackTemplate: config.templates.workflowSingle,
      fallbackVars: {
        AGENT_NAME: agentName,
        DESCRIPTION: description,
      },
    };
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
 * Gather tool selection via keyword-aware picker and build the AgentBlueprint.
 * All data assembly and IO (directory resolution) happens in exec().
 */
class ToolUseBlueprintNode extends Node<AgentCreatorShared> {
  async prep(shared: AgentCreatorShared) {
    return {
      agentName: shared.agentName!,
      description: shared.description!,
      config: shared.config,
    };
  }

  async exec(prepRes: {
    agentName: string;
    description: string;
    config: CreatorConfig;
  }): Promise<AgentBlueprint | undefined> {
    const { agentName, description, config } = prepRes;

    const picked = await pickTools(agentName, description);
    if (!picked) return undefined;

    const targetDir = await agentDirectories.custom();

    return {
      category: 'toolUse',
      agentName,
      filePath: vscode.Uri.file(path.join(targetDir, `${agentName}.yaml`)),
      aiVars: {
        AGENT_NAME: agentName,
        DESCRIPTION: description,
        SELECTED_TOOLS: picked.tools.join(', '),
        SELECTED_GROUPS: picked.groups.join(', '),
      },
      fallbackTemplate: config.templates.toolUse,
      fallbackVars: {
        AGENT_NAME: agentName,
        DESCRIPTION: description,
        TOOLS_YAML: picked.tools.map((t) => `    - ${t}`).join('\n'),
      },
    };
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

interface GeneratePrepResult {
  config: CreatorConfig;
  blueprint: AgentBlueprint;
}

/**
 * Generate agent YAML via AI. Uses PocketFlow retry (maxRetries) for validation
 * failures and execFallback for template-based fallback when retries are exhausted.
 */
class GenerateNode extends Node<AgentCreatorShared> {
  private lastValidationError?: string;

  constructor() {
    super(AI_GENERATION_ATTEMPTS);
  }

  async prep(shared: AgentCreatorShared): Promise<GeneratePrepResult> {
    return { config: shared.config, blueprint: shared.blueprint! };
  }

  async exec(prepRes: GeneratePrepResult): Promise<string> {
    const { config, blueprint } = prepRes;
    const helperResult = await createHelperModelKit();
    if (!helperResult.kit) {
      throw new Error(helperResult.reason);
    }
    const { handler, client } = helperResult.kit;

    const prompts = config[blueprint.category];
    const schemaRef = getSchemaReference(blueprint.category);
    const renderVars = {
      ...PASSTHROUGH[blueprint.category],
      ...blueprint.aiVars,
    };
    const systemPrompt =
      nunjucksEnv.renderString(prompts.systemPrompt, renderVars) +
      '\n' +
      schemaRef;

    let userMessage = nunjucksEnv.renderString(prompts.userRequest, renderVars);
    if (this.lastValidationError) {
      userMessage +=
        '\n' +
        nunjucksEnv.renderString(config.retryPrompts[blueprint.category], {
          VALIDATION_ERROR: this.lastValidationError,
        });
    }

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

    if (!isNonEmptyString(text)) {
      throw new Error('Model returned no text');
    }

    const extracted = extractTextFromTag(text, 'yaml');
    const candidate = (extracted || text).trim();
    try {
      validateAgentYamlContent(candidate);
    } catch (err) {
      this.lastValidationError = toErrorMessage(err);
      throw new Error(
        `Generated YAML was invalid: ${this.lastValidationError}`,
      );
    }

    logger.info(
      CHANNEL,
      `AI generation succeeded for ${blueprint.category} agent`,
    );
    return candidate;
  }

  async execFallback(
    prepRes: GeneratePrepResult,
    error: Error,
  ): Promise<string> {
    logger.warn(
      CHANNEL,
      `AI generation failed, using template: ${error.message}`,
    );
    const { blueprint } = prepRes;
    // Route through the shared renderer so both the Settings "new from
    // template" flow and this fallback produce byte-identical output for
    // matching inputs. Category-specific passthrough is unnecessary here —
    // the shared helper passes every runtime token through, and the
    // bundled templates only reference the ones they need.
    return renderAgentTemplateString(
      blueprint.fallbackTemplate,
      blueprint.fallbackVars,
    );
  }

  async post(
    shared: AgentCreatorShared,
    _prepRes: unknown,
    yamlContent: string,
  ): Promise<string | undefined> {
    shared.yamlContent = yamlContent;
    return FlowTransition.DEFAULT;
  }
}

/**
 * Write generated YAML to disk, register the agent, and open the file.
 */
class RegisterNode extends Node<AgentCreatorShared> {
  async prep(shared: AgentCreatorShared) {
    return { blueprint: shared.blueprint!, yamlContent: shared.yamlContent! };
  }

  async exec(prepRes: { blueprint: AgentBlueprint; yamlContent: string }) {
    const { blueprint, yamlContent } = prepRes;
    await AbsoluteFS.write(blueprint.filePath.fsPath, yamlContent);
    vscode.window.showInformationMessage(
      `Created agent at ${blueprint.filePath.fsPath}`,
    );
    await promptToAddAgentToConfig(
      blueprint.agentName,
      false,
      blueprint.category,
    );
    const doc = await vscode.workspace.openTextDocument(blueprint.filePath);
    await vscode.window.showTextDocument(doc);
  }

  async post(): Promise<string | undefined> {
    return FlowTransition.DEFAULT;
  }
}

// ── Flow ────────────────────────────────────────────────────

function createAgentCreatorFlow(): Flow<AgentCreatorShared> {
  const gatherInput = new GatherInputNode();
  const workflowBlueprint = new WorkflowBlueprintNode();
  const toolUseBlueprint = new ToolUseBlueprintNode();
  const generate = new GenerateNode();
  const register = new RegisterNode();

  gatherInput.on('workflow', workflowBlueprint);
  gatherInput.on('toolUse', toolUseBlueprint);

  workflowBlueprint.next(generate);
  toolUseBlueprint.next(generate);
  generate.next(register);

  return new Flow<AgentCreatorShared>(gatherInput);
}

export async function handleCreateAgentWithAI(
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
