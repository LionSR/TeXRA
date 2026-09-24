import * as path from 'node:path';

import { Data, Effect, FileSystem } from 'effect';
import * as yaml from 'yaml';
import { z } from 'zod';

import {
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
  AgentPromptSchema,
} from '@agent/core/definition/AgentDataclass';
import { helperCompletion, helperModel } from '@agent/runtime/helperModel';
import { validateAgentYamlContent } from '@agent/runtime/agentLoad';
import { renderAgentTemplateString } from '@agent/templates/agentTemplateRenderer';
import { withLogChannel } from '@logger/effectLog';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { AgentDirectories, AppState } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { GlobalStorageFs } from '@platform/rootedFs';
import type { AgentCategory } from '@shared/schemas';
import { TOOL_JSON_SCHEMA_OPTIONS } from '@shared/tools/toolJsonSchema';
import { TOOL_PLUGINS } from '@tools/plugins';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { extractTextFromTag } from '@utils/text/xmlExtraction';
import type { HttpClient } from 'effect/unstable/http';

const CHANNEL = 'AgentCreator';

// ── Template parsing ────────────────────────────────────────
//
// Parses the bundled agent-creator YAML templates and assembles the
// `CreatorConfig` below. Hosts own only resolving where the template files
// live and reading their bytes (see `buildCreatorConfig`); this module owns
// validating and shaping that content.

// Validation only — no .trim() transform, so multiline block-scalar prompts
// (including their trailing newline) pass through verbatim.
const PromptStringSchema = z.string().refine((value) => value.trim() !== '', {
  error: 'prompt must not be empty',
});

// Top level stays non-strict: templates carry metadata (name, description,
// settings) that this loader does not consume. The prompts block is strict so
// a misspelled key (e.g. `userRequst`) fails the load instead of being
// silently stripped.
const ParsedCreatorYamlSchema = z.object({
  prompts: z.strictObject({
    systemPrompt: PromptStringSchema,
    userRequest: PromptStringSchema,
  }),
});

// ── Types ───────────────────────────────────────────────────

// Derived from the prompts block the template parser validates — the schema
// is the SSOT for this shape.
type AgentPromptPair = z.infer<typeof ParsedCreatorYamlSchema>['prompts'];

export interface CreatorConfig {
  workflow: AgentPromptPair;
  toolUse: AgentPromptPair;
  retryPrompt: string;
  templates: {
    workflowSingle: string;
    toolUse: string;
  };
}

function parseCreatorTemplate(
  fileName: string,
  raw: string,
): z.infer<typeof ParsedCreatorYamlSchema> {
  const parsed = ParsedCreatorYamlSchema.safeParse(yaml.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Invalid bundled agent-creator template ${fileName}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

const RETRY_PROMPT =
  'The previous attempt failed validation: {{ VALIDATION_ERROR }}. Fix it and return only the YAML.\n';

/** Raw bytes of the four bundled template files, already read by the host. */
interface CreatorTemplateFiles {
  workflowYaml: string;
  toolUseYaml: string;
  workflowSingle: string;
  toolUseTpl: string;
}

export function buildCreatorConfig(files: CreatorTemplateFiles): CreatorConfig {
  const wf = parseCreatorTemplate(
    'agentCreatorWorkflow.yaml',
    files.workflowYaml,
  );
  const tu = parseCreatorTemplate(
    'agentCreatorToolUse.yaml',
    files.toolUseYaml,
  );
  return {
    workflow: wf.prompts,
    toolUse: tu.prompts,
    retryPrompt: RETRY_PROMPT,
    templates: {
      workflowSingle: files.workflowSingle,
      toolUse: files.toolUseTpl,
    },
  };
}

interface AgentBlueprint {
  category: AgentCategory;
  filePath: string;
  aiVars: Record<string, string>;
  fallbackTemplate: string;
  fallbackVars: Record<string, string>;
}

/** One pickable tool group of the agent creator: a dashboard-listed plugin. */
interface ToolGroup {
  readonly description: string;
  readonly tools: readonly string[];
}

/** The plugin every suggestion includes, as a safe baseline for any tool-use
 *  agent. */
const BASELINE_PLUGIN_ID = 'file-ops';

/** Every plugin the Tools dashboard lists; hidden ones are not offered. */
const GROUP_PLUGINS = TOOL_PLUGINS.filter((plugin) => plugin.hidden !== true);

/** The agent creator's tool groups, keyed by plugin name in manifest order. */
export const TOOL_GROUPS: Readonly<Record<string, ToolGroup>> =
  Object.fromEntries(
    GROUP_PLUGINS.map((plugin) => [
      plugin.name,
      { description: plugin.description, tools: plugin.toolNames },
    ]),
  );

/**
 * Tool groups whose plugin keywords match `description`, plus the baseline
 * plugin's group.
 */
function suggestToolGroups(description: string): string[] {
  const lower = description.toLowerCase();
  return GROUP_PLUGINS.filter(
    (plugin) =>
      plugin.id === BASELINE_PLUGIN_ID ||
      plugin.keywords?.some((kw) => lower.includes(kw)) === true,
  ).map((plugin) => plugin.name);
}

/**
 * Why one of the creator's host steps could not be carried out.
 *
 * The reasons are the distinct things the host layer does on this flow's
 * behalf, read off the one implementation
 * (`packages/extension/src/commands/agent/agentCreatorCommands.ts`): show an
 * input box or tool picker, resolve the custom-agents directory, register the
 * new agent in the user's configuration, open the created file, and render the
 * fallback template.
 *
 * A user who cancels is not a failure: the prompts answer `undefined` and the
 * wizard returns without side effects, exactly as before.
 */
export class AgentCreatorUiFailed extends Data.TaggedError(
  'AgentCreatorUiFailed',
)<{
  readonly reason:
    | 'prompt-failed'
    | 'directory-unavailable'
    | 'config-update-failed'
    | 'open-failed'
    | 'render-failed';
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * All host-specific operations injected by the VS Code command layer.
 * Keeps the creation workflow independent of VS Code.
 *
 * Every member that waits on the host is an `Effect`: its failure reaches the
 * wizard as {@link AgentCreatorUiFailed} rather than as `unknown`, and
 * interrupting the wizard closes the input box or picker it left on screen.
 * `showCreatedInfo` and `renderTemplate` stay synchronous — one is a
 * fire-and-forget notice, the other a pure render.
 */
export interface AgentCreatorUI {
  promptAgentName(
    categoryLabel: string,
  ): Effect.Effect<string | undefined, AgentCreatorUiFailed>;
  promptDescription(
    title: string,
    prompt: string,
  ): Effect.Effect<string | undefined, AgentCreatorUiFailed>;
  pickTools(
    agentName: string,
    suggestedGroups: string[],
  ): Effect.Effect<
    { tools: string[]; groups: string[] } | undefined,
    AgentCreatorUiFailed
  >;
  getCustomAgentDir(): Effect.Effect<
    string,
    AgentCreatorUiFailed,
    GlobalStorageFs | FileSystem.FileSystem
  >;
  showCreatedInfo(filePath: string): void;
  promptAddToConfig(
    agentName: string,
    category: AgentCategory,
  ): Effect.Effect<
    void,
    AgentCreatorUiFailed,
    | GlobalStorageFs
    | FileSystem.FileSystem
    | AgentDirectories
    | AppState
    | LanguageModel
  >;
  openCreatedFile(filePath: string): Effect.Effect<void, AgentCreatorUiFailed>;
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
  const json = (schema: z.ZodType) =>
    JSON.stringify(z.toJSONSchema(schema, TOOL_JSON_SCHEMA_OPTIONS), null, 2);
  return [
    '## Agent YAML Schema (JSON Schema)',
    '',
    '### settings',
    json(settingsSchema),
    '',
    '### prompts',
    json(AgentPromptSchema),
  ].join('\n');
}

// ── Creation stages ─────────────────────────────────────────

const buildAgentBlueprint = Effect.fn('agentCreator.buildBlueprint')(function* (
  config: CreatorConfig,
  category: AgentCategory,
  agentName: string,
  description: string,
  ui: AgentCreatorUI,
): Effect.fn.Return<
  AgentBlueprint | undefined,
  AgentCreatorUiFailed,
  GlobalStorageFs | FileSystem.FileSystem
> {
  const base = { AGENT_NAME: agentName, DESCRIPTION: description };

  if (category === 'toolUse') {
    const picked = yield* ui.pickTools(
      agentName,
      suggestToolGroups(description),
    );
    if (!picked) return undefined;
    const targetDir = yield* ui.getCustomAgentDir();
    return {
      category: 'toolUse',
      filePath: path.join(targetDir, `${agentName}.yaml`),
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

  const targetDir = yield* ui.getCustomAgentDir();
  return {
    category: 'workflow',
    filePath: path.join(targetDir, `${agentName}.yaml`),
    aiVars: { ...base },
    fallbackTemplate: config.templates.workflowSingle,
    fallbackVars: { ...base },
  };
});

/**
 * Draft the agent YAML with the helper model: one initial attempt and one
 * validation retry that carries the validation error back, then the
 * deterministic template. Each attempt binds the helper model afresh.
 */
const generateAgentYaml = Effect.fn('agentCreator.generateYaml')(function* (
  config: CreatorConfig,
  blueprint: AgentBlueprint,
  ui: AgentCreatorUI,
  stores: ModelOptionStores,
): Effect.fn.Return<string, Error, LanguageModel | HttpClient.HttpClient> {
  let lastValidationError: string | undefined;

  const attempt = Effect.gen(function* () {
    const bound = yield* helperModel(stores);

    const prompts = config[blueprint.category];
    const schemaRef = getSchemaReference(blueprint.category);
    const systemPrompt =
      renderAgentTemplateString(prompts.systemPrompt, blueprint.aiVars) +
      '\n' +
      schemaRef;

    let userMessage = renderAgentTemplateString(
      prompts.userRequest,
      blueprint.aiVars,
    );
    if (lastValidationError) {
      userMessage +=
        '\n' +
        renderAgentTemplateString(config.retryPrompt, {
          VALIDATION_ERROR: lastValidationError,
        });
    }

    const text = yield* helperCompletion(bound, {
      userPrompt: userMessage,
      systemPrompt,
    });
    if (!isNonEmptyString(text)) {
      return yield* Effect.fail(new Error('Model returned no text'));
    }

    const extracted = extractTextFromTag(text, 'yaml');
    const candidate = (extracted || text).trim();
    yield* validateAgentYamlContent(candidate).pipe(
      Effect.mapError((error) => {
        lastValidationError = toErrorMessage(error);
        return new Error(`Generated YAML was invalid: ${lastValidationError}`);
      }),
    );

    yield* Effect.logInfo(
      `AI generation succeeded for ${blueprint.category} agent`,
    ).pipe(withLogChannel(CHANNEL));
    return candidate;
  }).pipe(Effect.scoped);

  return yield* attempt.pipe(
    Effect.retry({ times: AI_GENERATION_ATTEMPTS - 1 }),
    Effect.tapError((error) =>
      Effect.logWarning(
        `AI generation failed, using template: ${toErrorMessage(error)}`,
      ).pipe(withLogChannel(CHANNEL)),
    ),
    // Route through the shared renderer so both the Settings "new from
    // template" flow and this fallback produce byte-identical output for
    // matching inputs.
    Effect.catch(() =>
      Effect.try({
        try: () =>
          ui.renderTemplate(blueprint.fallbackTemplate, blueprint.fallbackVars),
        catch: (cause) =>
          new AgentCreatorUiFailed({
            reason: 'render-failed',
            message: 'The fallback agent template could not be rendered.',
            cause,
          }),
      }),
    ),
  );
});

/**
 * Run the complete agent-creation wizard, stopping without side effects when
 * cancelled. The host's UI calls are its ports; their failures are the
 * host's own errors.
 *
 * `stores` are the secret store and the host's three setting slots the command
 * already holds; the helper model that drafts the YAML is resolved and bound
 * against them.
 */
export const runAgentCreator = Effect.fn('runAgentCreator')(function* (
  config: CreatorConfig,
  category: AgentCategory,
  ui: AgentCreatorUI,
  stores: ModelOptionStores,
): Effect.fn.Return<
  void,
  Error,
  | FileSystem.FileSystem
  | GlobalStorageFs
  | LanguageModel
  | HttpClient.HttpClient
  | AgentDirectories
  | AppState
> {
  const categoryLabel = category === 'toolUse' ? 'Tool Use' : 'Workflow';
  const agentName = yield* ui.promptAgentName(categoryLabel);
  if (!agentName) return;

  const description = yield* ui.promptDescription(
    `New ${categoryLabel} Agent: ${agentName}`,
    DESCRIPTION_PROMPTS[category],
  );
  if (!description) return;

  const blueprint = yield* buildAgentBlueprint(
    config,
    category,
    agentName,
    description,
    ui,
  );
  if (!blueprint) return;

  const yamlContent = yield* generateAgentYaml(config, blueprint, ui, stores);
  // The blueprint's path is absolute and its directory is the one the UI
  // just answered with, so the write goes through the process filesystem.
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(blueprint.filePath, yamlContent);
  ui.showCreatedInfo(blueprint.filePath);
  yield* ui.promptAddToConfig(agentName, category);
  yield* ui.openCreatedFile(blueprint.filePath);
});
