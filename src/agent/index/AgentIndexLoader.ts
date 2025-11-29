/**
 * AgentIndexLoader - Populates the AgentIndex with entries from all sources.
 *
 * This loader is called once during extension activation to scan all agent
 * directories and fetch remote agent metadata. It uses ASYNC operations only.
 */

import * as path from 'path';
import { glob } from 'glob';
import * as yaml from 'yaml';

import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';
import {
  AgentCategory,
  AgentDefinitionSchema,
  AgentType,
} from '@agent/core/AgentDataclass';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';
import { getConfig } from '@utils/config';

import { AgentIndex } from './AgentIndex';
import { AgentIndexEntry } from './AgentIndexEntry';

const CHANNEL = 'AgentIndexLoader';
logger.initialize(CHANNEL);

const YAML_EXTENSION = '.yaml';
const MULTIPLE_SUFFIX = '_multiple';

/**
 * Map a raw agentType string to the AgentType enum.
 * Defaults to CoT for workflow agents if unspecified.
 */
function mapAgentType(agentType: string | undefined): AgentType {
  if (agentType === AgentType.ToolUse || agentType === 'toolUse') {
    return AgentType.ToolUse;
  }
  if (agentType === AgentType.Direct || agentType === 'direct') {
    return AgentType.Direct;
  }
  return AgentType.CoT;
}

interface ScannedAgent {
  name: string;
  definitionPath: string;
  multipleVariantPath?: string;
}

/**
 * Loader class for populating the AgentIndex.
 */
export class AgentIndexLoader {
  /**
   * Initialize the agent index by scanning all sources.
   * This should be called during extension activation.
   */
  static async initialize(): Promise<void> {
    const initPromise = this.loadAll();
    AgentIndex.setInitPromise(initPromise);
    await initPromise;
  }

  /**
   * Load all agents from all sources into the index.
   */
  static async loadAll(): Promise<void> {
    logger.info(CHANNEL, 'Loading agent index from all sources...');

    const startTime = Date.now();

    // Clear any existing/stale entries before loading fresh data
    // This ensures deleted agents don't persist from previous sessions
    AgentIndex.clear();

    // Load from all sources in parallel
    const [
      customEntries,
      builtInEntries,
      builtInToolUseEntries,
      remoteEntries,
    ] = await Promise.all([
      this.loadFromDirectory(
        AgentDirectorySource.Custom,
        await agentDirectories.custom(),
      ),
      this.loadFromDirectory(
        AgentDirectorySource.BuiltIn,
        await agentDirectories.builtIn(),
      ),
      this.loadFromDirectory(
        AgentDirectorySource.BuiltInToolUse,
        await agentDirectories.builtInToolUse(),
      ),
      this.loadRemoteAgents(),
    ]);

    const allEntries = this.applyConfiguredCategoryOverrides([
      ...customEntries,
      ...builtInEntries,
      ...builtInToolUseEntries,
      ...remoteEntries,
    ]);

    // Register all entries
    AgentIndex.registerMultiple(allEntries);

    const elapsed = Date.now() - startTime;
    logger.info(
      CHANNEL,
      `Agent index loaded: ${allEntries.length} agents in ${elapsed}ms`,
    );
  }

  /**
   * Refresh agents from a specific source.
   */
  static async refreshSource(source: AgentDirectorySource): Promise<void> {
    logger.info(CHANNEL, `Refreshing agents from source: ${source}`);

    AgentIndex.clearSource(source);

    let entries: AgentIndexEntry[];

    switch (source) {
      case AgentDirectorySource.Custom:
        entries = await this.loadFromDirectory(
          source,
          await agentDirectories.custom(),
        );
        break;
      case AgentDirectorySource.BuiltIn:
        entries = await this.loadFromDirectory(
          source,
          await agentDirectories.builtIn(),
        );
        break;
      case AgentDirectorySource.BuiltInToolUse:
        entries = await this.loadFromDirectory(
          source,
          await agentDirectories.builtInToolUse(),
        );
        break;
      case AgentDirectorySource.Remote:
        entries = await this.loadRemoteAgents();
        break;
    }

    const processedEntries = this.applyConfiguredCategoryOverrides(entries);
    AgentIndex.registerMultiple(processedEntries);
  }

  /**
   * Apply configured category overrides from texra.toolUseAgents setting.
   * Agents listed in this config are treated as tool-use agents regardless of
   * their YAML-defined category.
   */
  private static applyConfiguredCategoryOverrides(
    entries: AgentIndexEntry[],
  ): AgentIndexEntry[] {
    const configuredToolUseAgents = new Set(
      getConfig<string[]>('texra.toolUseAgents', []),
    );

    if (configuredToolUseAgents.size === 0) {
      return entries;
    }

    return entries.map((entry) =>
      configuredToolUseAgents.has(entry.name)
        ? { ...entry, category: AgentCategory.ToolUse }
        : entry,
    );
  }

  /**
   * Refresh all sources.
   */
  static async refreshAll(): Promise<void> {
    AgentIndex.clear();
    await this.loadAll();
  }

  /**
   * Load agents from a local directory.
   */
  private static async loadFromDirectory(
    source: AgentDirectorySource,
    directory: string,
  ): Promise<AgentIndexEntry[]> {
    if (!directory) {
      return [];
    }

    try {
      // Scan for all YAML files
      const scannedAgents = await this.scanDirectory(directory);
      const entries: AgentIndexEntry[] = [];

      for (const scanned of scannedAgents) {
        try {
          const entry = await this.createEntryFromYaml(
            source,
            scanned.name,
            scanned.definitionPath,
            scanned.multipleVariantPath,
          );
          entries.push(entry);
        } catch (error) {
          logger.warn(
            CHANNEL,
            `Failed to load agent "${scanned.name}" from ${source}: ${error}`,
          );
        }
      }

      logger.debug(
        CHANNEL,
        `Loaded ${entries.length} agents from ${source} (${directory})`,
      );
      return entries;
    } catch (error) {
      logger.error(CHANNEL, `Failed to scan directory ${directory}: ${error}`);
      return [];
    }
  }

  /**
   * Scan a directory for agent YAML files.
   * Groups base agents with their _multiple variants.
   */
  private static async scanDirectory(
    directory: string,
  ): Promise<ScannedAgent[]> {
    const pattern = `**/*${YAML_EXTENSION}`;
    const matches = await glob(pattern, {
      cwd: directory,
      absolute: true,
      nodir: true,
    });

    // Group files by base name (without _multiple suffix)
    const agentMap = new Map<string, ScannedAgent>();

    for (const filePath of matches) {
      const fileName = path.basename(filePath, YAML_EXTENSION);

      // Determine base name and whether this is a _multiple variant
      const isMultiple = fileName.endsWith(MULTIPLE_SUFFIX);
      const baseName = isMultiple
        ? fileName.slice(0, -MULTIPLE_SUFFIX.length)
        : fileName;

      // Get or create agent entry
      let agent = agentMap.get(baseName);
      if (!agent) {
        agent = { name: baseName, definitionPath: '' };
        agentMap.set(baseName, agent);
      }

      // Assign paths
      if (isMultiple) {
        agent.multipleVariantPath = filePath;
      } else {
        agent.definitionPath = filePath;
      }
    }

    // Filter out agents that only have _multiple variant (no base)
    // and ensure all agents have a definition path
    const result: ScannedAgent[] = [];
    for (const agent of agentMap.values()) {
      if (agent.definitionPath) {
        result.push(agent);
      } else if (agent.multipleVariantPath) {
        // Only _multiple exists, use it as the definition
        agent.definitionPath = agent.multipleVariantPath;
        agent.name = `${agent.name}${MULTIPLE_SUFFIX}`;
        agent.multipleVariantPath = undefined;
        result.push(agent);
      }
    }

    return result;
  }

  /**
   * Create an AgentIndexEntry from a YAML file.
   * Uses lightweight metadata extraction - full validation happens at load time.
   */
  private static async createEntryFromYaml(
    source: AgentDirectorySource,
    name: string,
    definitionPath: string,
    multipleVariantPath?: string,
  ): Promise<AgentIndexEntry> {
    const content = await AbsoluteFS.read(definitionPath);
    const parsed = yaml.parse(content);
    const validated = AgentDefinitionSchema.parse(parsed);

    // Extract only the metadata we need from settings (skip strict validation)
    // Full schema validation happens at execution time in agentLoad.ts
    const rawSettings = (validated.settings || {}) as Record<string, unknown>;
    const agentType = rawSettings.agentType as string | undefined;
    const defaultOutputFiles = rawSettings.defaultOutputFiles as
      | string[]
      | undefined;
    const isMultipleOutput = rawSettings.isMultipleOutput as
      | boolean
      | undefined;

    // Determine category from source and settings
    let category: AgentCategory;
    if (source === AgentDirectorySource.BuiltInToolUse) {
      category = AgentCategory.ToolUse;
    } else if (agentType === AgentType.ToolUse) {
      category = AgentCategory.ToolUse;
    } else {
      category = AgentCategory.Workflow;
    }

    const entry: AgentIndexEntry = {
      name,
      source,
      category,
      definitionPath,
      multipleVariantPath,
      hasDefinition: true,
      hasMultipleSibling: Boolean(multipleVariantPath),
      isMultipleOutput: isMultipleOutput ?? false,
      description: validated.description,
      defaultOutputFiles:
        defaultOutputFiles && defaultOutputFiles.length > 0
          ? defaultOutputFiles
          : undefined,
      agentType: mapAgentType(agentType),
    };
    return entry;
  }

  /**
   * Load remote agents from Supabase.
   */
  private static async loadRemoteAgents(): Promise<AgentIndexEntry[]> {
    const remoteEnabled = getConfig<boolean>(
      'texra.remoteAgents.enabled',
      true,
    );
    if (!remoteEnabled) {
      return [];
    }

    try {
      const remoteAgents = await RemoteAgentLoader.listRemoteAgents();

      return remoteAgents.map((agent): AgentIndexEntry => {
        // Determine category from agentType field
        const category =
          agent.agentType === 'toolUse'
            ? AgentCategory.ToolUse
            : AgentCategory.Workflow;

        return {
          name: agent.name,
          source: AgentDirectorySource.Remote,
          category,
          definitionPath: '', // Remote agents don't have local paths
          hasDefinition: true, // Assume remote agents are valid
          hasMultipleSibling: false,
          isMultipleOutput: false, // Default, will be determined at load time
          description: agent.description,
          visibility: agent.visibility,
          agentType: mapAgentType(agent.agentType),
        };
      });
    } catch (error) {
      logger.warn(CHANNEL, `Failed to load remote agents: ${error}`);
      return [];
    }
  }
}
