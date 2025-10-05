// Standard library imports
import * as path from 'path';

// Third-party imports
import deepmerge from 'deepmerge';
import * as vscode from 'vscode';
import * as yaml from 'yaml';

// Local imports - agent components
import {
  AgentSetting,
  AgentPrompt,
  AgentPromptSchema,
  AgentDefinitionSchema,
  AgentType,
  parseAgentSetting,
  type AgentCategory,
} from '@agent/core/AgentDataclass';

// Local imports - utils
import * as logger from '@logger/logUtils';
import type { ToolDefinition } from '@model';
import { AbsoluteFS } from '@utils/files';
import type { AgentPathResolution } from './AgentPathTypes';
import { AgentDirectorySource } from './AgentPathTypes';

const CHANNEL = 'agentLoad';
logger.initialize(CHANNEL);

export interface ValidAgentDefinition {
  name: string;
  settings: AgentSetting;
}

/** Loads and parses a YAML file from an absolute path. */
export async function loadYaml(absolutePath: string): Promise<object> {
  try {
    if (!path.isAbsolute(absolutePath)) {
      throw new Error('loadYaml requires an absolute path');
    }

    // Read and parse YAML
    const yamlContent = await AbsoluteFS.read(absolutePath);
    const parsedYaml = yaml.parse(yamlContent);

    console.log(`Successfully loaded YAML from: ${absolutePath}`);
    return parsedYaml;
  } catch (err) {
    const moreInfo = 'More Info';
    vscode.window
      .showErrorMessage(
        `Error loading YAML file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
        moreInfo,
      )
      .then((selection) => {
        if (selection === moreInfo) {
          void vscode.commands.executeCommand('texra.openDoc', 'custom-agents');
        }
      });
    throw err;
  }
}

/**
 * Loads agent settings and prompts with inheritance support.
 * Merges with parent configurations if specified in the inherits field.
 *
 * The {@link LoadAgentOptions.preferMultiple} flag only affects the initial
 * agent being resolved. Parent definitions always load their base variant so
 * that inherited prompts remain consistent with the author's expectations.
 */
interface LoadAgentOptions {
  preferMultiple?: boolean;
}

export function ensureAgentTypeForSource<
  T extends {
    agentType?: AgentType;
    agentCategory?: AgentCategory;
  },
>(settings: T, source: AgentDirectorySource): T {
  if (
    source === AgentDirectorySource.BuiltInToolUse &&
    settings.agentType === undefined
  ) {
    settings.agentType = AgentType.ToolUse;
    if (settings.agentCategory === undefined) {
      settings.agentCategory = 'toolUse';
    }
  }
  return settings;
}

async function resolveAgentDefinition(
  agentDirectory: string,
  agentNameFromFile: string,
  options?: LoadAgentOptions,
): Promise<{ filePath: string; resolvedName: string }> {
  const preferMultiple = options?.preferMultiple ?? false;
  const candidateNames: string[] = [];

  if (preferMultiple) {
    const preferredName = agentNameFromFile.endsWith('_multiple')
      ? agentNameFromFile
      : `${agentNameFromFile}_multiple`;
    candidateNames.push(preferredName);
  }

  candidateNames.push(agentNameFromFile);

  const seenCandidates = new Set<string>();
  for (const candidate of candidateNames) {
    if (seenCandidates.has(candidate)) {
      continue;
    }
    seenCandidates.add(candidate);

    const candidatePath = path.join(agentDirectory, `${candidate}.yaml`);
    if (await AbsoluteFS.exists(candidatePath)) {
      if (
        preferMultiple &&
        candidate === agentNameFromFile &&
        !agentNameFromFile.endsWith('_multiple')
      ) {
        logger.warn(
          CHANNEL,
          `Requested multiple outputs for agent "${agentNameFromFile}" but no _multiple definition was found. Falling back to base definition.`,
        );
      }
      return { filePath: candidatePath, resolvedName: candidate };
    }
  }

  const fallbackPath = path.join(agentDirectory, `${agentNameFromFile}.yaml`);
  if (preferMultiple && !agentNameFromFile.endsWith('_multiple')) {
    logger.warn(
      CHANNEL,
      `Requested multiple outputs for agent "${agentNameFromFile}" but no _multiple definition was found. Falling back to base definition.`,
    );
  }
  return { filePath: fallbackPath, resolvedName: agentNameFromFile };
}

export async function loadAgentSettingAndPrompts(
  agentPath: AgentPathResolution,
  agentNameFromFile: string,
  options?: LoadAgentOptions,
): Promise<[AgentSetting, AgentPrompt]> {
  try {
    const { filePath: agentFile, resolvedName } = await resolveAgentDefinition(
      agentPath.directory,
      agentNameFromFile,
      options,
    );
    const rawConfig = await loadYaml(agentFile);
    const config = AgentDefinitionSchema.parse(rawConfig);

    // Extract the agent's declared name from the root of the YAML, if present.
    // This is the authoritative name for this specific agent definition.
    // It's used for context or can be returned if needed, but not part of AgentSetting object.
    const declaredAgentName = config.name;
    // logger.debug(CHANNEL, `Declared agent name for ${agentNameFromFile}: ${declaredAgentName}`); // Optional: for debugging

    const parent = config.inherits;

    let settings: Partial<AgentSetting> = {};
    let prompts: Partial<AgentPrompt> = {};

    if (parent) {
      // Load parent settings and prompts recursively
      // Note: The 'name' of the parent agent isn't directly used to override the current agent's settings block structure.
      const [parentSettings, parentPrompts] = await loadAgentSettingAndPrompts(
        agentPath,
        parent, // Parent's name (from its filename or root 'name') is used for recursive loading
        // Intentionally omit options so parents always load their base
        // definition instead of inheriting multiple-output preferences.
      );

      // Get current agent's specific settings and prompts from its YAML
      const agentOwnSettings = config.settings ?? {};
      const agentOwnPrompts = config.prompts ?? {};

      // Merge with parent settings and prompts
      settings = deepmerge(parentSettings, agentOwnSettings, {
        arrayMerge: (_d, s) => s,
      });
      prompts = deepmerge(parentPrompts, agentOwnPrompts, {
        arrayMerge: (_d, s) => s,
      });
    } else {
      // No inheritance, just take own settings and prompts
      settings = deepmerge({}, config.settings ?? {}, {
        arrayMerge: (_d, s) => s,
      });
      prompts = deepmerge({}, config.prompts ?? {}, {
        arrayMerge: (_d, s) => s,
      });
    }

    ensureAgentTypeForSource(settings, agentPath.source);

    // Resolve tool names to definitions
    if (Array.isArray(settings.tools)) {
      const { DEFAULT_TOOL_REGISTRY } = await import('@tools/registry');
      settings.tools = (settings.tools as any[]).map((item) => {
        if (typeof item === 'string') {
          const tool = DEFAULT_TOOL_REGISTRY[item];
          if (!tool) {
            logger.warn(CHANNEL, `Tool "${item}" not found in registry`);
            return { name: item } as ToolDefinition;
          }
          return tool.definition;
        }
        if (!DEFAULT_TOOL_REGISTRY[item.name]) {
          logger.warn(CHANNEL, `Tool "${item.name}" not found in registry`);
        }
        return item as ToolDefinition;
      });
    }

    // Apply defaults and validate the final settings and prompts
    const validatedSettings = parseAgentSetting(settings);
    const validatedPrompts = AgentPromptSchema.parse(prompts);
    settings = validatedSettings;
    prompts = validatedPrompts;

    // The function returns the validated settings block and prompts.
    // The agent's name (declaredAgentName) is known in this scope but not part of AgentSetting.
    if (
      options?.preferMultiple &&
      resolvedName.endsWith('_multiple') &&
      !agentNameFromFile.endsWith('_multiple')
    ) {
      logger.debug(
        CHANNEL,
        `Using _multiple agent definition "${resolvedName}" for base agent "${agentNameFromFile}".`,
      );
    }

    return [settings as AgentSetting, prompts as AgentPrompt];
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error loading agent settings and prompts: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Check whether a YAML file represents a valid agent configuration.
 * Returns an object with the agent's root name and its settings if valid, otherwise null.
 */
export async function isValidAgentYaml(
  filePath: string,
): Promise<ValidAgentDefinition | null> {
  try {
    const rawData = await loadYaml(filePath);
    const data = AgentDefinitionSchema.parse(rawData);

    if (!data.settings || !data.prompts) {
      logger.debug(
        CHANNEL,
        `isValidAgentYaml check failed for ${filePath}: missing settings or prompts block`,
      );
      return null;
    }

    const settingsBlock = parseAgentSetting(data.settings);
    AgentPromptSchema.parse(data.prompts);
    const rootName = data.name;

    if (rootName === '') {
      logger.debug(
        CHANNEL,
        `isValidAgentYaml check failed for ${filePath}: name is empty`,
      );
      return null;
    }

    return {
      name: rootName,
      settings: settingsBlock,
    } satisfies ValidAgentDefinition;
  } catch (err) {
    logger.debug(
      CHANNEL,
      `isValidAgentYaml check failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}
