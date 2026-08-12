import * as path from 'node:path';

import { resolveAgent } from '@agent/index/agentRegistry';
import type { ResolvedAgent } from '@agent/index/agentEntry';
import {
  AgentPromptSchema,
  AgentDefinitionSchema,
  AgentSettingSchema,
  type AgentSetting,
  type AgentSettingInput,
  type AgentPrompt,
  type AgentPromptInput,
} from '@agent/core/definition/AgentDataclass';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import { inlineAgentDefinition } from '@agent/index/inlineAgents';
import { loadRemoteAgent } from '@agent/remote/RemoteAgentLoader';
import { parseYamlWith, safeParseYaml } from '@common/parsing/safeParseYaml';
import {
  agentKey,
  AgentCategory,
  type AgentSource,
} from '@shared/schemas/agent';
import { AbsoluteFS } from '@utils/files/absoluteFS';

import { resolveAgentSettingTools } from './agentSettingTools';

const CHANNEL = 'agentLoad';

export interface AgentYamlValidationResult {
  name: string;
  settings: AgentSettingInput;
  prompts: AgentPromptInput;
}

/**
 * Parses a YAML string or already-parsed object and validates that it
 * represents a full agent definition. Returns the validated name, settings,
 * and prompts so callers can reuse consistent schema checks across string and
 * file based workflows.
 */
export function validateAgentYamlContent(
  content: string | object,
): AgentYamlValidationResult {
  let data: ReturnType<(typeof AgentDefinitionSchema)['parse']>;
  if (typeof content === 'string') {
    const parsed = parseYamlWith(content, AgentDefinitionSchema);
    if (parsed.isErr()) {
      throw new Error(`Failed to parse agent YAML: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    data = parsed.value;
  } else {
    data = AgentDefinitionSchema.parse(content);
  }
  // `name` is validated by AgentNameSchema on both parse paths (trim + min 1),
  // so the returned name is guaranteed non-empty and trimmed.
  const rootName = data.name;

  if (!data.inherits) {
    AgentSettingSchema.parse(resolveAgentSettingTools(data.settings, CHANNEL));
    AgentPromptSchema.parse(data.prompts);
  }

  return {
    name: rootName,
    settings: data.settings,
    prompts: data.prompts,
  };
}

/** Loads and parses a YAML file from an absolute path. */
async function loadYaml(absolutePath: string): Promise<object> {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error('loadYaml requires an absolute path');
  }

  const yamlContent = await AbsoluteFS.read(absolutePath);
  const parsed = safeParseYaml(yamlContent);
  if (parsed.isErr()) {
    throw new Error(
      `Failed to parse YAML at ${absolutePath}: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.value as object;
}

function ensureAgentCategoryForSource<
  T extends { agentCategory?: AgentCategory },
>(settings: T, source: AgentSource): T {
  if (source === 'builtInToolUse' && !settings.agentCategory) {
    return { ...settings, agentCategory: AgentCategory.ToolUse };
  }
  return settings;
}

export async function loadAgentSettingAndPrompts(
  resolution: ResolvedAgent,
  seen: ReadonlySet<string> = new Set(),
): Promise<[AgentSetting, AgentPrompt]> {
  const { entry } = resolution;

  // Handle inline agents: the definition was supplied as a value and validated
  // at registration, so there is nothing to read from disk. Tools and defaults
  // still go through the same resolution the YAML path uses below.
  if (entry.source === 'inline') {
    // Prefer the definition carried in the resolution — it's the exact one
    // the resolver selected, not whatever a concurrent re-registration may
    // have replaced (Fix #9). Fall back to the live lookup for callers that
    // construct a ResolvedAgent without the field.
    const definition =
      resolution.inlineDefinition ?? inlineAgentDefinition(entry.name);
    const settings =
      entry.category === AgentCategory.ToolUse
        ? toToolUseSettings(definition.settings)
        : {
            ...definition.settings,
            agentCategory: AgentCategory.Workflow,
          };
    return [
      AgentSettingSchema.parse(resolveAgentSettingTools(settings, CHANNEL)),
      AgentPromptSchema.parse(definition.prompts),
    ];
  }

  // Handle remote agents
  if (entry.source === 'remote') {
    const remoteConfig = await loadRemoteAgent(entry.name);

    // Remote agents are already fully processed (tools resolved, validated)
    return [remoteConfig.settings, remoteConfig.prompts];
  }

  // Mirrors the cycle guard in agentYamlScanner.ts's inheritedDefinitionBlock:
  // a self- or mutually-referential `inherits` chain must fail loudly here
  // (this is the runtime load path) rather than recurse without bound.
  const entryKey = agentKey(entry.source, entry.name);
  if (seen.has(entryKey)) {
    throw new Error(
      `Circular "inherits" chain detected: ${[...seen, entryKey].join(' -> ')}.`,
    );
  }
  const nextSeen = new Set([...seen, entryKey]);

  const rawConfig = await loadYaml(entry.path);
  const config = AgentDefinitionSchema.parse(rawConfig);

  // Initialize with own settings/prompts (spread creates a mutable copy).
  // Tools may still be raw name strings at this point — they are resolved below.
  let settings: AgentSettingInput = { ...config.settings };
  let prompts: AgentPromptInput = { ...config.prompts };

  // Merge with parent if inheritance is specified
  if (config.inherits) {
    const parentResolution = resolveAgent(
      agentKey(entry.source, config.inherits),
    );
    if (!parentResolution) {
      throw new Error(
        `Unable to locate parent agent "${config.inherits}" in source "${entry.source}".`,
      );
    }
    const [parentSettings, parentPrompts] = await loadAgentSettingAndPrompts(
      parentResolution,
      nextSeen,
    );

    // Parent provides defaults, child overrides.
    // parentSettings has resolved ToolDefinition objects while
    // config.settings may still have raw strings; AgentSetting's fields are a
    // structural subset of AgentSettingInput's (required vs. optional), so the
    // merge can be typed as AgentSettingInput directly without an
    // unknown-escaping cast.
    settings = mergeInheritedAgentObject<AgentSettingInput>(
      parentSettings,
      config.settings,
    );
    prompts = mergeInheritedAgentObject(parentPrompts, config.prompts);
  }

  settings = ensureAgentCategoryForSource(settings, entry.source);

  const resolvedSettings = resolveAgentSettingTools(settings, CHANNEL);

  // Apply defaults and validate the final settings and prompts
  return [
    AgentSettingSchema.parse(resolvedSettings),
    AgentPromptSchema.parse(prompts),
  ];
}

function toToolUseSettings(settings: AgentSettingInput): AgentSettingInput {
  const {
    rounds: _rounds,
    isRewrite: _isRewrite,
    ...sharedSettings
  } = settings;
  return {
    ...sharedSettings,
    agentCategory: AgentCategory.ToolUse,
  };
}
