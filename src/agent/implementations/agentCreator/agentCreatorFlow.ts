import * as path from 'node:path';

import nunjucks from 'nunjucks';
import pRetry from 'p-retry';
import { z } from 'zod';

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
import { buildUserVarPassthrough } from '@agent/prompt/userVars';
import { createLog } from '@logger/logUtils';
import type { AgentCategory } from '@shared/schemas';
import { DELEGATE_MULTI_AGENTS_TOOL_NAME } from '@shared/constants/delegationTools';
import { createTexraNunjucksEnvironment } from '@utils/prompt';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { extractTextFromTag } from '@utils/text/xmlExtraction';

const log = createLog('AgentCreator');

// ── Types ───────────────────────────────────────────────────

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

interface ToolGroup {
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
      DELEGATE_MULTI_AGENTS_TOOL_NAME,
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
function suggestToolGroups(description: string): string[] {
  const lower = description.toLowerCase();
  const suggested = new Set<string>(['File Operations']);
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (group.keywords.some((kw) => lower.includes(kw))) suggested.add(name);
  }
  return [...suggested];
}

/**
 * All host-specific operations injected by the VS Code command layer.
 * Keeps the creation workflow independent of VS Code.
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
  promptAddToConfig(agentName: string, category: AgentCategory): Promise<void>;
  openCreatedFile(filePath: string): Promise<void>;
  renderTemplate(template: string, vars: Record<string, unknown>): string;
}

// ── Infrastructure ──────────────────────────────────────────

/** Total AI generation attempts (1 initial + 1 validation retry) before template fallback. */
const AI_GENERATION_ATTEMPTS = 2;

const DESCRIPTION_PROMPTS: Record<AgentCategory, string> = {
  toolUse:
    'What should this agent do? List required capabilities, such as searching papers, editing files, or browsing the web.',
  workflow:
    'What should this agent do? State whether it rewrites existing documents or creates new ones.',
};

const PASSTHROUGH = buildUserVarPassthrough();

// No loader: only in-memory template strings are rendered here, never named
// template files, so `{% include %}`/`{% extends %}` never resolve.
const nunjucksEnv = createTexraNunjucksEnvironment(nunjucks);

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
  const schemaOptions = {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'input',
  } as const;
  return [
    '## Agent YAML Schema (JSON Schema)',
    '',
    '### settings',
    JSON.stringify(z.toJSONSchema(settingsSchema, schemaOptions), null, 2),
    '',
    '### prompts',
    JSON.stringify(z.toJSONSchema(AgentPromptSchema, schemaOptions), null, 2),
  ].join('\n');
}

// ── Creation stages ─────────────────────────────────────────

async function buildAgentBlueprint(
  config: CreatorConfig,
  category: AgentCategory,
  agentName: string,
  description: string,
  ui: AgentCreatorUI,
): Promise<AgentBlueprint | undefined> {
  const base = { AGENT_NAME: agentName, DESCRIPTION: description };
  const targetDir = await ui.getCustomAgentDir();
  const filePath = path.join(targetDir, `${agentName}.yaml`);

  if (category === 'toolUse') {
    const picked = await ui.pickTools(
      agentName,
      description,
      suggestToolGroups(description),
    );
    if (!picked) return undefined;
    return {
      category: 'toolUse',
      agentName,
      filePath,
      aiVars: {
        ...base,
        SELECTED_TOOLS: picked.tools.join(', '),
        SELECTED_GROUPS: picked.groups.join(', '),
      },
      fallbackTemplate: config.templates.toolUse,
      fallbackVars: {
        ...base,
        TOOLS_YAML: picked.tools.map((tool) => `    - ${tool}`).join('\n'),
      },
    };
  }

  return {
    category: 'workflow',
    agentName,
    filePath,
    aiVars: base,
    fallbackTemplate: config.templates.workflowSingle,
    fallbackVars: base,
  };
}

async function generateAgentYaml(
  config: CreatorConfig,
  blueprint: AgentBlueprint,
  ui: AgentCreatorUI,
): Promise<string> {
  let lastValidationError: string | undefined;

  try {
    return await pRetry(
      async () => {
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

        let userMessage = nunjucksEnv.renderString(
          prompts.userRequest,
          renderVars,
        );
        if (lastValidationError) {
          userMessage +=
            '\n' +
            nunjucksEnv.renderString(config.retryPrompts[blueprint.category], {
              VALIDATION_ERROR: lastValidationError,
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
        } catch (error) {
          lastValidationError = toErrorMessage(error);
          throw new Error(`Generated YAML was invalid: ${lastValidationError}`);
        }

        log.info(`AI generation succeeded for ${blueprint.category} agent`);
        return candidate;
      },
      {
        retries: AI_GENERATION_ATTEMPTS - 1,
        minTimeout: 0,
        factor: 1,
        randomize: false,
      },
    );
  } catch (error) {
    log.warn(`AI generation failed, using template: ${toErrorMessage(error)}`);
    // Route through the shared renderer so both the Settings "new from
    // template" flow and this fallback produce byte-identical output for
    // matching inputs.
    return ui.renderTemplate(
      blueprint.fallbackTemplate,
      blueprint.fallbackVars,
    );
  }
}

/** Run the complete agent-creation wizard, stopping without side effects when cancelled. */
export async function runAgentCreator(
  config: CreatorConfig,
  category: AgentCategory,
  ui: AgentCreatorUI,
): Promise<void> {
  const categoryLabel = category === 'toolUse' ? 'Tool Use' : 'Workflow';
  const agentName = await ui.promptAgentName(categoryLabel);
  if (!agentName) return;

  const description = await ui.promptDescription(
    `New ${categoryLabel} Agent: ${agentName}`,
    DESCRIPTION_PROMPTS[category],
  );
  if (!description) return;

  const blueprint = await buildAgentBlueprint(
    config,
    category,
    agentName,
    description,
    ui,
  );
  if (!blueprint) return;

  const yamlContent = await generateAgentYaml(config, blueprint, ui);
  await AbsoluteFS.write(blueprint.filePath, yamlContent);
  ui.showCreatedInfo(blueprint.filePath);
  await ui.promptAddToConfig(agentName, category);
  await ui.openCreatedFile(blueprint.filePath);
}
