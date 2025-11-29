/**
 * AgentIndex - Single source of truth for agent metadata.
 *
 * This class manages a cached index of all available agents from all sources:
 * - Custom (user-provided)
 * - BuiltIn (bundled workflow agents)
 * - BuiltInToolUse (bundled tool-use agents)
 * - Remote (Supabase-hosted agents)
 *
 * The index is populated once at activation and can be refreshed on demand.
 * Full agent settings/prompts are NOT cached here - they are loaded fresh
 * at execution time to ensure the latest YAML content is used.
 */

import * as path from 'path';
import {
  AgentDirectorySource,
  type AgentPathResolution,
} from '@agent/runtime/AgentPathTypes';
import { AgentCategory } from '@agent/core/AgentDataclass';
import * as logger from '@logger/logUtils';
import {
  AgentIndexEntry,
  AgentIndexKey,
  createAgentIndexKey,
  parseAgentIndexKey,
} from './AgentIndexEntry';

const CHANNEL = 'AgentIndex';
logger.initialize(CHANNEL);

/**
 * Singleton class managing the agent index.
 */
class AgentIndexClass {
  private entries = new Map<AgentIndexKey, AgentIndexEntry>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // Indexes for fast lookup
  private byName = new Map<string, AgentIndexEntry[]>();
  private byCategory = {
    workflow: [] as AgentIndexEntry[],
    toolUse: [] as AgentIndexEntry[],
  };

  /**
   * Rebuild the byName and byCategory indexes from entries.
   */
  private rebuildIndexes(): void {
    this.byName.clear();
    this.byCategory.workflow = [];
    this.byCategory.toolUse = [];

    for (const entry of this.entries.values()) {
      // Index by name
      const existing = this.byName.get(entry.name) ?? [];
      existing.push(entry);
      this.byName.set(entry.name, existing);

      // Index by category
      if (entry.category === AgentCategory.ToolUse) {
        this.byCategory.toolUse.push(entry);
      } else {
        this.byCategory.workflow.push(entry);
      }
    }
  }

  /**
   * Check if the index has been populated.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Wait for initialization to complete if in progress.
   */
  async waitForInitialization(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Set the initialization promise (called by loader).
   */
  setInitPromise(promise: Promise<void>): void {
    this.initPromise = promise;
    promise
      .then(() => {
        this.initialized = true;
      })
      .catch((err) => {
        logger.error(
          CHANNEL,
          `Index initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.initPromise = null;
      });
  }

  /**
   * Register multiple agent entries at once.
   */
  registerMultiple(entries: AgentIndexEntry[]): void {
    for (const entry of entries) {
      const key = createAgentIndexKey(entry.source, entry.name);
      this.entries.set(key, entry);
    }
    this.rebuildIndexes();
  }

  /**
   * Clear all entries from a specific source.
   * Used when refreshing agents from that source.
   */
  clearSource(source: AgentDirectorySource): void {
    const keysToDelete: AgentIndexKey[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.source === source) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.entries.delete(key);
    }
    this.rebuildIndexes();
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
    this.rebuildIndexes();
  }

  /**
   * Get an entry by source and name.
   */
  getEntry(
    source: AgentDirectorySource,
    name: string,
  ): AgentIndexEntry | undefined {
    const key = createAgentIndexKey(source, name);
    return this.entries.get(key);
  }

  /**
   * Get all entries for a given agent name (from all sources).
   */
  getEntriesByName(name: string): AgentIndexEntry[] {
    return this.byName.get(name) ?? [];
  }

  /**
   * Get all workflow agent entries.
   */
  getWorkflowEntries(): AgentIndexEntry[] {
    return [...this.byCategory.workflow];
  }

  /**
   * Get all tool-use agent entries.
   */
  getToolUseEntries(): AgentIndexEntry[] {
    return [...this.byCategory.toolUse];
  }

  /**
   * Get all entries from a specific source.
   */
  getBySource(source: AgentDirectorySource): AgentIndexEntry[] {
    return Array.from(this.entries.values()).filter(
      (entry) => entry.source === source,
    );
  }

  /**
   * Get an entry by identifier string.
   * Handles both "source:name" and legacy "name" formats.
   *
   * @param identifier - Either "source:name" format or just "name"
   * @returns The entry or undefined if not found
   */
  getEntryByIdentifier(identifier: string): AgentIndexEntry | undefined {
    const parsed = parseAgentIndexKey(identifier);
    if (parsed) {
      return this.getEntry(parsed.source, parsed.name);
    }
    // Legacy format: return first matching entry
    return this.getEntriesByName(identifier)[0];
  }

  /**
   * Resolve an agent identifier to path information.
   *
   * This is the PRIMARY resolution method - use this instead of manual lookups.
   *
   * @param identifier - Either "source:name" format or just "name" (legacy)
   * @param options - Resolution options (preferMultiple for _multiple variants)
   * @returns AgentPathResolution or undefined if not found
   */
  resolve(
    identifier: string,
    options?: { preferMultiple?: boolean },
  ): AgentPathResolution | undefined {
    const preferMultiple = options?.preferMultiple ?? false;

    // Parse identifier: "source:name" or just "name"
    const parsed = parseAgentIndexKey(identifier);
    const explicitSource = parsed?.source ?? null;
    const agentName = parsed?.name ?? identifier;

    // Find the entry
    let entry: AgentIndexEntry | undefined;
    if (explicitSource) {
      entry = this.getEntry(explicitSource, agentName);
    } else {
      // Legacy format: find first matching entry (priority order from index)
      const entries = this.getEntriesByName(agentName);
      entry = entries[0];
    }

    if (!entry) {
      return undefined;
    }

    // Remote agents have no local paths
    if (entry.source === AgentDirectorySource.Remote) {
      return {
        directory: '',
        source: AgentDirectorySource.Remote,
        definitionPath: '',
        resolvedName: entry.name,
        usedFallback: false,
      };
    }

    // Local agents must have a definition path
    if (!entry.definitionPath) {
      return undefined;
    }

    // Determine which path to use based on preferMultiple flag
    let definitionPath = entry.definitionPath;
    let resolvedName = entry.name;
    const usedFallback = preferMultiple && !entry.hasMultipleSibling;

    if (preferMultiple && entry.multipleVariantPath) {
      definitionPath = entry.multipleVariantPath;
      resolvedName = `${entry.name}_multiple`;
    }

    return {
      directory: path.dirname(definitionPath),
      source: entry.source,
      definitionPath,
      resolvedName,
      usedFallback,
    };
  }
}

/** Singleton agent index instance. */
export const AgentIndex = new AgentIndexClass();
