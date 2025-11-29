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

import * as vscode from 'vscode';
import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';
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

/** Persisted state structure for the agent index. */
interface PersistedIndexState {
  version: number;
  entries: Array<{
    key: AgentIndexKey;
    entry: AgentIndexEntry;
  }>;
  lastUpdated: number;
}

const STORAGE_KEY = 'texra.agentIndex.v1';
const CURRENT_VERSION = 1;

/**
 * Singleton class managing the agent index.
 */
class AgentIndexClass {
  private context: vscode.ExtensionContext | null = null;
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
   * Initialize the index with ExtensionContext.
   * Must be called during extension activation.
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.restoreFromStorage();
  }

  /**
   * Restore index from persisted storage.
   */
  private restoreFromStorage(): void {
    if (!this.context) return;

    const persisted = this.context.globalState.get<PersistedIndexState>(
      STORAGE_KEY,
    );

    if (persisted && persisted.version === CURRENT_VERSION) {
      this.entries.clear();
      for (const { key, entry } of persisted.entries) {
        this.entries.set(key, entry);
      }
      this.rebuildIndexes();
    }
  }

  /**
   * Persist current state to storage.
   */
  private async persist(): Promise<void> {
    if (!this.context) return;

    const state: PersistedIndexState = {
      version: CURRENT_VERSION,
      entries: Array.from(this.entries.entries()).map(([key, entry]) => ({
        key,
        entry,
      })),
      lastUpdated: Date.now(),
    };

    await this.context.globalState.update(STORAGE_KEY, state);
  }

  /**
   * Persist with error logging.
   * Use this instead of void this.persist() to avoid silent failures.
   */
  private persistWithLogging(): void {
    this.persist().catch((err) => {
      logger.error(
        CHANNEL,
        `Failed to persist agent index: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

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
   * Register a single agent entry.
   */
  register(entry: AgentIndexEntry): void {
    const key = createAgentIndexKey(entry.source, entry.name);
    this.entries.set(key, entry);
    this.rebuildIndexes();
    this.persistWithLogging();
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
    this.persistWithLogging();
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
    this.persistWithLogging();
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
    this.rebuildIndexes();
    this.persistWithLogging();
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
   * Get an entry by composite key.
   */
  getEntryByKey(key: AgentIndexKey): AgentIndexEntry | undefined {
    return this.entries.get(key);
  }

  /**
   * Get an entry by parsing a key string.
   * Returns undefined if the key is invalid or entry not found.
   */
  getEntryByKeyString(keyString: string): AgentIndexEntry | undefined {
    const parsed = parseAgentIndexKey(keyString);
    if (!parsed) return undefined;
    return this.getEntry(parsed.source, parsed.name);
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
   * Get all entries.
   */
  getAllEntries(): AgentIndexEntry[] {
    return Array.from(this.entries.values());
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
   * Get the total number of entries.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Check if an agent exists with the given source and name.
   */
  has(source: AgentDirectorySource, name: string): boolean {
    return this.entries.has(createAgentIndexKey(source, name));
  }

  /**
   * Check if any agent exists with the given name (from any source).
   */
  hasName(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Get default output files for an agent.
   * Returns from cache if available, undefined otherwise.
   */
  getDefaultOutputFiles(
    source: AgentDirectorySource,
    name: string,
  ): string[] | undefined {
    return this.getEntry(source, name)?.defaultOutputFiles;
  }

  /**
   * Check if an agent is from a remote source.
   */
  isRemote(source: AgentDirectorySource, name: string): boolean {
    const entry = this.getEntry(source, name);
    return entry?.source === AgentDirectorySource.Remote;
  }

  /**
   * Legacy compatibility: Check if name exists in remote agents.
   * Prefer using explicit source when possible.
   */
  isRemoteByName(name: string): boolean {
    const entries = this.getEntriesByName(name);
    return entries.some((e) => e.source === AgentDirectorySource.Remote);
  }
}

/** Singleton agent index instance. */
export const AgentIndex = new AgentIndexClass();
