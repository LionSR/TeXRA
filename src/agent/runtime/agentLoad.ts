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
} from '@agent/core/AgentDataclass';

// Local imports - utils
import * as logger from '@logger/logUtils';
import type { ToolDefinition } from '@model';
import { AbsoluteFS } from '@utils/files';
import type { AgentPathResolution } from './AgentPathTypes';
import { AgentDirectorySource } from './AgentPathTypes';
import { resolveAgentDefinitionInDirectory } from '@agent/utils/agentPathResolver';

const CHANNEL = 'agentLoad';
logger.initialize(CHANNEL);

export interface ValidAgentDefinition {
  name: string;
  settings: AgentSetting;
}

export interface AgentYamlValidationResult extends ValidAgentDefinition {
  prompts: AgentPrompt;
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
  const raw = typeof content === 'string' ? yaml.parse(content) : content;
  const data = AgentDefinitionSchema.parse(raw);
  const settingsBlock = parseAgentSetting(data.settings);
  const promptsBlock = AgentPromptSchema.parse(data.prompts);
  const rootName = typeof data.name === 'string' ? data.name.trim() : '';

  if (!rootName) {
    throw new Error('name is empty');
  }

  return {
    name: rootName,
    settings: settingsBlock,
    prompts: promptsBlock,
  } satisfies AgentYamlValidationResult;
}

/** Loads and parses a YAML file from an absolute path. */
export async function loadYaml(absolutePath: string): Promise<object> {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error('loadYaml requires an absolute path');
  }

  const yamlContent = await AbsoluteFS.read(absolutePath);
  return yaml.parse(yamlContent);
}

export function notifyYamlLoadFailure(
  absolutePath: string,
  error: unknown,
): void {
  const moreInfo = 'More Info';
  const openFile = 'Open File';

  void vscode.window
    .showErrorMessage(
      `Error loading YAML file ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      moreInfo,
      openFile,
    )
    .then(async (selection) => {
      if (selection === moreInfo) {
        void vscode.commands.executeCommand('texra.openDoc', 'custom-agents');
        return;
      }

      if (selection === openFile) {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(absolutePath),
        );
        await vscode.window.showTextDocument(document);
      }
    });
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

export function ensureAgentTypeForSource<T extends { agentType?: AgentType }>(
  settings: T,
  source: AgentDirectorySource,
): T {
  if (
    source === AgentDirectorySource.BuiltInToolUse &&
    settings.agentType === undefined
  ) {
    settings.agentType = AgentType.ToolUse;
  }
  return settings;
}

function mergeAgentBlocks<T>(
  base: Partial<T>,
  override: Partial<T>,
): Partial<T> {
  return deepmerge(base, override, { arrayMerge: (_dest, source) => source });
}

export async function loadAgentSettingAndPrompts(
  resolution: AgentPathResolution,
  options?: LoadAgentOptions,
): Promise<[AgentSetting, AgentPrompt]> {
  try {
    if (options?.preferMultiple && resolution.usedFallback) {
      logger.warn(
        CHANNEL,
        `Requested multiple outputs for agent "${resolution.resolvedName.replace(/_multiple$/, '')}" but no _multiple definition was found. Falling back to base definition.`,
      );
    }

    const rawConfig = await loadYaml(resolution.definitionPath);
    const config = AgentDefinitionSchema.parse(rawConfig);

    // Extract the agent's declared name from the root of the YAML, if present.
    // This is the authoritative name for this specific agent definition.
    // It's used for context or can be returned if needed, but not part of AgentSetting object.
    const declaredAgentName = config.name;
    // logger.debug(CHANNEL, `Declared agent name: ${declaredAgentName}`); // Optional: for debugging

    const parent = config.inherits;

    let settings: Partial<AgentSetting> = {};
    let prompts: Partial<AgentPrompt> = {};

    if (parent) {
      const parentResolution = await resolveAgentDefinitionInDirectory(
        resolution.directory,
        resolution.source,
        parent,
      );
      if (!parentResolution) {
        throw new Error(
          `Unable to locate parent agent "${parent}" in ${resolution.directory}.`,
        );
      }
      const [parentSettings, parentPrompts] =
        await loadAgentSettingAndPrompts(parentResolution);
      settings = mergeAgentBlocks(parentSettings, config.settings);
      prompts = mergeAgentBlocks(parentPrompts, config.prompts);
    } else {
      settings = mergeAgentBlocks({}, config.settings);
      prompts = mergeAgentBlocks({}, config.prompts);
    }

    ensureAgentTypeForSource(settings, resolution.source);

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
    const { name, settings } = validateAgentYamlContent(rawData);

    return {
      name,
      settings,
    } satisfies ValidAgentDefinition;
  } catch (err) {
    logger.debug(
      CHANNEL,
      `isValidAgentYaml check failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}
