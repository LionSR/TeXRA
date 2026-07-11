import * as path from 'node:path';

import * as nunjucks from 'nunjucks';
import { z } from 'zod';

import { Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
  AgentPromptSchema,
} from '@agent/core/definition/AgentDataclass';
import {
  createHelperModelKit,
  runHelperModelCompletion,
} from '@agent/runtime/helperModel';
import { validateAgentYamlContent } from '@agent/runtime/agentLoad';
import { buildUserVarPassthrough } from '@agent/utils/userVars';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { extractTextFromTag } from '@utils/text/xmlExtraction';

const CHANNEL = 'AgentCreator';

// ── Types ───────────────────────────────────────────────────

export type AgentCategory = 'workflow' | 'toolUse';

interface AgentPromptPair {
  systemPrompt: string;
  userRequest: string;
}

export interface CreatorConfig {
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
  filePath: string;
  aiVars: Record<string, string>;
  fallbackTemplate: string;
  fallbackVars: Record<string, string>;
}

/** Mutable shared state flowing through the agent creation flow. */
export interface AgentCreatorShared {
  config: CreatorConfig;
  category: AgentCategory;
  agentName?: string;
  description?: string;
  blueprint?: AgentBlueprint;
  yamlContent?: string;
}

export interface ToolGroup {
  description: string;
  tools: string[];
  keywords: string[];
}

export const TOOL_GROUPS: Record<string, ToolGroup> = {
  'File Operations': {
    description: 'Read, write, edit, search files and run shell commands',
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
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
    tools: [
      'zotero_add',
      'zotero_search',
      'zotero_export',
      'zotero_collections',
    ],
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

/**
 * Tool groups whose keywords match `description`. `File Operations` is
 * always included as a safe baseline for any tool-use agent.
 */
export function suggestToolGroups(description: string): string[] {
  const lower = description.toLowerCase();
  const suggested = new Set<string>(['File Operations']);
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (group.keywords.some((kw) => lower.includes(kw))) suggested.add(name);
  }
  return [...suggested];
}

/**
 * All host-specific operations injected by the VS Code command layer.
 * Allows the flow and nodes to run without importing vscode.
 */
export interface AgentCreatorUI {
  promptAgentName(categoryLabel: string): Promise<string | undefined>;
  promptDescription(title: string, prompt: string): Promise<string | undefined>;
  pickTools(
    agentName: string,
    description: string,
    suggestedGroups: string[],
  ): Promise<{ tools: string[]; groups: string[] } | undefined>;
  getCustomAgentDir(): Promise<string>;
  showCreatedInfo(filePath: string): void;
  promptAddToConfig(
    agentName: string,
    isEdited: boolean,
    category: AgentCategory,
  ): Promise<void>;
  openCreatedFile(filePath: string): Promise<void>;
  renderTemplate(template: string, vars: Record<string, unknown>): string;
}

// ── Infrastructure ──────────────────────────────────────────

/** Total AI generation attempts (1 initial + 1 validation retry) before template fallback. */
const AI_GENERATION_ATTEMPTS = 2;

const DESCRIPTION_PROMPTS: Record<AgentCategory, string> = {
  toolUse:
    'What should this agent do? Mention capabilities it needs (e.g., search papers, edit files, browse the web)',
  workflow:
    'What should this agent do? Mention whether it rewrites existing documents or creates new ones',
};

const PASSTHROUGH = buildUserVarPassthrough();

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

// ── Nodes ───────────────────────────────────────────────────

class GatherInputNode extends Node<AgentCreatorShared> {
  constructor(private ui: AgentCreatorUI) {
    super();
  }

  async prep(shared: AgentCreatorShared) {
    return {
      category: shared.category,
      categoryLabel: shared.category === 'toolUse' ? 'Tool Use' : 'Workflow',
    };
  }

  async exec(prepRes: { category: AgentCategory; categoryLabel: string }) {
    const agentName = await this.ui.promptAgentName(prepRes.categoryLabel);
    if (!agentName) return undefined;

    const description = await this.ui.promptDescription(
      `New ${prepRes.categoryLabel} Agent: ${agentName}`,
      DESCRIPTION_PROMPTS[prepRes.category],
    );
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
 * Builds the {@link AgentBlueprint} for the category chosen upstream. Both
 * categories share the same prep/post and the same `AGENT_NAME`/`DESCRIPTION`
 * render vars; only `toolUse` runs the tool-pick step and contributes the
 * tool-derived vars. The tool pick happens before the target directory is
 * resolved so cancelling it short-circuits without side effects.
 */
class BlueprintNode extends Node<AgentCreatorShared> {
  constructor(private ui: AgentCreatorUI) {
    super();
  }

  async prep(shared: AgentCreatorShared) {
    return {
      category: shared.category,
      agentName: shared.agentName!,
      description: shared.description!,
      config: shared.config,
    };
  }

  async exec(prepRes: {
    category: AgentCategory;
    agentName: string;
    description: string;
    config: CreatorConfig;
  }): Promise<AgentBlueprint | undefined> {
    const { category, agentName, description, config } = prepRes;
    const base = { AGENT_NAME: agentName, DESCRIPTION: description };

    if (category === 'toolUse') {
      const picked = await this.ui.pickTools(
        agentName,
        description,
        suggestToolGroups(description),
      );
      if (!picked) return undefined;
      const targetDir = await this.ui.getCustomAgentDir();
      return {
        category: 'toolUse',
        agentName,
        filePath: path.join(targetDir, `${agentName}.yaml`),
        aiVars: {
          ...base,
          SELECTED_TOOLS: picked.tools.join(', '),
          SELECTED_GROUPS: picked.groups.join(', '),
        },
        fallbackTemplate: config.templates.toolUse,
        fallbackVars: {
          ...base,
          TOOLS_YAML: picked.tools.map((t) => `    - ${t}`).join('\n'),
        },
      };
    }

    const targetDir = await this.ui.getCustomAgentDir();
    return {
      category: 'workflow',
      agentName,
      filePath: path.join(targetDir, `${agentName}.yaml`),
      aiVars: { ...base },
      fallbackTemplate: config.templates.workflowSingle,
      fallbackVars: { ...base },
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

class GenerateNode extends Node<AgentCreatorShared> {
  private lastValidationError?: string;

  constructor(private ui: AgentCreatorUI) {
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

    const prompts = config[blueprint.category];
    const schemaRef = getSchemaReference(blueprint.category);
    const renderVars = {
      ...PASSTHROUGH,
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

    const text = await runHelperModelCompletion(helperResult.kit, {
      userPrompt: userMessage,
      systemPrompt,
    });

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
    // matching inputs.
    return this.ui.renderTemplate(
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

class RegisterNode extends Node<AgentCreatorShared> {
  constructor(private ui: AgentCreatorUI) {
    super();
  }

  async prep(shared: AgentCreatorShared) {
    return { blueprint: shared.blueprint!, yamlContent: shared.yamlContent! };
  }

  async exec(prepRes: { blueprint: AgentBlueprint; yamlContent: string }) {
    const { blueprint, yamlContent } = prepRes;
    await AbsoluteFS.write(blueprint.filePath, yamlContent);
    this.ui.showCreatedInfo(blueprint.filePath);
    await this.ui.promptAddToConfig(
      blueprint.agentName,
      false,
      blueprint.category,
    );
    await this.ui.openCreatedFile(blueprint.filePath);
  }

  async post(): Promise<string | undefined> {
    return FlowTransition.DEFAULT;
  }
}

// ── Flow ────────────────────────────────────────────────────

export function createAgentCreatorFlow(
  ui: AgentCreatorUI,
): Flow<AgentCreatorShared> {
  const gatherInput = new GatherInputNode(ui);
  const blueprint = new BlueprintNode(ui);
  const generate = new GenerateNode(ui);
  const register = new RegisterNode(ui);

  gatherInput.on('workflow', blueprint);
  gatherInput.on('toolUse', blueprint);

  blueprint.next(generate);
  generate.next(register);

  return new Flow<AgentCreatorShared>(gatherInput);
}
