/**
 * Summary disk-cache lane for the transcript store.
 *
 * `streamLogSummaries/` is the derived-tier (#9434) mirror of each stream's
 * `StreamLogSummary` beside the authoritative `streamLogs/` files: a stale or
 * corrupt cache entry is discarded and rebuilt from the stream log, never
 * migrated. This store owns the whole lane — preparing the cache directory,
 * the schema-validated read with its stale/orphaned mtime checks, the
 * best-effort maintain/delete/clear writes (a failed write disables
 * maintenance loudly rather than repeatedly failing), and the startup sweep
 * that rebuilds the resident summaries from the persisted logs.
 *
 * It reaches the rest of the transcript store only through
 * {@link StreamSummaryCacheHost} — the authoritative log reads and the
 * persisted-entry parse boundary stay owned by `StreamLogStore`, as do the
 * resident `summaries` map and the hot-path `refreshSummary`.
 */

import pMap from 'p-map';
import { z } from 'zod';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { KVStore } from '@common/storage/KVStore';
import { createLog } from '@logger/logUtils';
import {
  AgentCategorySchema,
  ExecutionIdSchema,
  RunIdentitySchema,
  TokenUsageStatsSchema,
  UserFollowUpSupportSchema,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import {
  isRunningGroupEntry,
  isRunningStreamingTextEntry,
  nonterminalWorkflowCall,
  type StreamLogPreservedRawEntry,
} from '@shared/session/traceEntries';
import { filterNotNull } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';

/** Logged under the store's channel: this is one of its internals. */
const log = createLog('StreamLogStore');

const STREAM_LOG_LOAD_CONCURRENCY = 8;

/**
 * Snapshot-owned display metadata mirrored into the always-resident summary,
 * so sidebars and all-streams metadata paths never read the per-stream
 * sidecar files (#9947, PRD 2026-08-11). `StreamSnapshotStore` is the
 * authority and publishes a whole replacement object on every metadata
 * mutation and on every sidecar hydration (which lazily backfills legacy
 * summaries written before this field existed). Bounded scalars only:
 * `command` carries a process run's command line, never an agent run's
 * full instruction text.
 */
const StreamSummaryMetaSchema = z.object({
  identity: RunIdentitySchema.optional(),
  executionId: ExecutionIdSchema.optional(),
  parentStreamId: z.string().min(1).optional(),
  userFollowUpSupport: UserFollowUpSupportSchema.optional(),
  agentCategory: AgentCategorySchema.optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  workingDirectory: z.string().optional(),
  command: z.string().optional(),
  /**
   * The stream's summed run usage, mirrored so a released sidecar record still
   * answers the roster's token column. Re-published on every usage write.
   */
  cumulativeUsage: TokenUsageStatsSchema.optional(),
});
export type StreamSummaryMeta = z.infer<typeof StreamSummaryMetaSchema>;

// No per-field `.catch()`: this schema covers the crash-recovery flags
// (`hasRunningGroup`, `hasRunningStreamingText`, `hasNonterminalWorkflowCall`)
// that `hasSomethingRunning()` gates orphan recovery on. A `.catch()` here
// would silently turn a malformed field into `undefined` (recovery skipped)
// instead of failing the whole `safeParse`, which routes through the
// "ignore cache, rebuild from stream log" fallback in `readSummary` — the
// derived-tier discard+rebuild contract (#9434): a stale-shaped summary is
// discarded and rebuilt from the authoritative stream log (its `meta` block
// is rebuilt lazily by the snapshot store's next publish), never migrated.
const StreamLogSummarySchema = z.object({
  firstTimestamp: z.number().finite().optional(),
  lastTimestamp: z.number().finite().optional(),
  hasRunningGroup: z.boolean().optional(),
  hasRunningStreamingText: z.boolean().optional(),
  hasNonterminalWorkflowCall: z.boolean().optional(),
  meta: StreamSummaryMetaSchema.optional(),
});
export type StreamLogSummary = z.infer<typeof StreamLogSummarySchema>;

/**
 * The one schema-validated read path for the persisted `StreamLogSummary`
 * shape — every reader of the summary cache (this store's `readSummary` and
 * the standalone `clearPersistedSummaryParentStream` patch in
 * `StreamLogStore`) goes through this instead of trusting a raw
 * `KVStore.read()` cast. Does not apply the loader's own
 * registration-evidence gate (see `readSummary`): a metadata-only summary
 * persisted before a stream's first append (see `recordSummaryMeta`) has no
 * timestamps but is still a valid, live entry, so only the loader — which
 * has a log-rebuild fallback for a timestamp-less entry — additionally
 * filters on that.
 */
export function parseSummaryShape(
  value: unknown,
): StreamLogSummary | undefined {
  // A missing cache file (KVStore's quiet-missing `undefined`) is an
  // ordinary rebuild, not a stale shape — nothing to warn about.
  if (value === undefined) return undefined;
  const result = StreamLogSummarySchema.safeParse(value);
  if (!result.success) {
    // Derived tier (#9434): ignore the stale-shaped cache loudly instead of
    // migrating it in place. Worded for both callers — the loader then
    // rebuilds from the authoritative stream log, while the standalone
    // parent-edge patch below just skips its write — neither "discards"
    // anything from storage on this path.
    log.warn(
      `Ignoring a stale-shaped summary cache entry: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
    return undefined;
  }
  return result.data;
}

export interface ParsedPersistedEntries {
  entries: StreamLogEntry[];
  preservedRawEntries: StreamLogPreservedRawEntry[];
}

interface StreamLoadResult {
  streamId: StreamTabId;
  summary: StreamLogSummary;
}

/**
 * Shared projection into {@link StreamLogSummary}, fed either by a resident
 * `StreamLog` (whose getters satisfy this shape) or by a raw entries scan
 * (`summarizeEntries`). Keeping the field list here means a new derived flag
 * is added once instead of in two hand-synced call sites.
 */
interface SummarySource {
  readonly firstTimestamp: number | undefined;
  readonly lastTimestamp: number | undefined;
  readonly hasRunningGroup: boolean;
  readonly hasRunningStreamingText: boolean;
  readonly hasNonterminalWorkflowCall: boolean;
}
export function toSummary(source: SummarySource): StreamLogSummary {
  return {
    firstTimestamp: source.firstTimestamp,
    lastTimestamp: source.lastTimestamp,
    hasRunningGroup: source.hasRunningGroup,
    hasRunningStreamingText: source.hasRunningStreamingText,
    ...(source.hasNonterminalWorkflowCall
      ? { hasNonterminalWorkflowCall: true }
      : {}),
  };
}

/**
 * The narrow port back into the transcript store. Every member is a read of
 * the authoritative stream logs (or the store's persisted-entry parse
 * boundary) that the summary-cache lane cannot own itself.
 */
export interface StreamSummaryCacheHost {
  /** Ids of every persisted transcript (registration evidence for the open sweep). */
  listPersistedStreamIds(): Promise<string[]>;
  /**
   * Raw persisted entries of one stream (KVStore's quiet-missing `undefined`
   * included).
   */
  readLogEntries(streamId: StreamTabId): Promise<unknown[] | undefined>;
  /**
   * Mtime of the authoritative stream log, for the stale/orphaned-cache check
   * in `readSummary`.
   */
  logModifiedAt(streamId: StreamTabId): Promise<number | undefined>;
  /** Parse raw persisted entries through the store's schema boundary (#7464). */
  parsePersistedEntries(
    streamId: StreamTabId,
    rawEntries: unknown,
  ): ParsedPersistedEntries;
}

export class StreamSummaryCacheStore {
  /**
   * Handle over the summary-cache directory (the authoritative logs KV stays
   * with `StreamLogStore`). A handle holds only the storage-root-relative
   * directory, and every operation re-resolves the root.
   */
  private readonly summariesKv = new KVStore(
    WORKSPACE_STORAGE_LAYOUT.streamLogSummaries,
    { compactJson: true },
  );
  private summaryCacheMaintenanceEnabled = true;

  constructor(
    private readonly host: StreamSummaryCacheHost,
    private readonly persistent: boolean,
  ) {}

  async prepareSummaryCache(): Promise<void> {
    try {
      await StorageFS.ensureDir(WORKSPACE_STORAGE_LAYOUT.streamLogSummaries);
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to prepare transcript summary cache; continuing with authoritative logs: ${toErrorMessage(error)}`,
      );
    }
  }

  async readPersistentSummaries(): Promise<Map<StreamTabId, StreamLogSummary>> {
    const streamIds = await this.host.listPersistedStreamIds();
    const results = await pMap(
      streamIds,
      (streamId) => this.loadStreamSummary(streamId as StreamTabId),
      { concurrency: STREAM_LOG_LOAD_CONCURRENCY },
    );
    const sortedResults = results
      .filter(filterNotNull)
      .sort(
        (a, b) =>
          (a.summary.firstTimestamp ?? Number.POSITIVE_INFINITY) -
            (b.summary.firstTimestamp ?? Number.POSITIVE_INFINITY) ||
          a.streamId.localeCompare(b.streamId),
      );

    return new Map(
      sortedResults.map(({ streamId, summary }) => [streamId, summary]),
    );
  }

  async loadStreamSummary(
    streamId: StreamTabId,
  ): Promise<StreamLoadResult | null> {
    const persistedSummary = await this.readSummary(streamId);
    if (persistedSummary) {
      return { streamId, summary: persistedSummary };
    }

    const raw = await this.host.readLogEntries(streamId);
    // `listKeys()` found the stream, but it may have been deleted before the
    // read completed. Only an existing authoritative `[]` is registration
    // evidence; KVStore's missing-file `undefined` is not.
    if (raw === undefined) return null;
    const entries = this.host.parsePersistedEntries(streamId, raw);
    const summary = this.summarizeEntries(entries.entries);
    // Empty transcripts have no timestamps, so their authoritative log file,
    // rather than the optional summary cache, remains the registration marker.
    if (entries.entries.length > 0 || entries.preservedRawEntries.length > 0) {
      await this.maintainSummaryCache(streamId, summary);
    }
    return { streamId, summary };
  }

  private async readSummary(
    streamId: StreamTabId,
  ): Promise<StreamLogSummary | undefined> {
    try {
      const persisted = await this.summariesKv.read<unknown>(streamId);
      const summary = parseSummaryShape(persisted);
      if (!summary) return undefined;
      // Empty transcripts have no timestamps, so a timestamp-less summary
      // cache entry isn't evidence the stream is registered — rebuild from
      // the authoritative stream log for that case instead of trusting it.
      if (
        summary.firstTimestamp === undefined &&
        summary.lastTimestamp === undefined
      ) {
        return undefined;
      }

      const [summaryMtime, logMtime] = await Promise.all([
        this.summariesKv.modifiedAt(streamId),
        this.host.logModifiedAt(streamId),
      ]);
      // A missing log mtime means the authoritative log is gone (deleted, or
      // never written) — orphaned summary, not merely stale. Trusting it here
      // would register a stream that has no log to load, so `ensureLoaded`
      // reads back an empty transcript instead of surfacing it as missing.
      if (
        summaryMtime !== undefined &&
        (logMtime === undefined || summaryMtime < logMtime)
      ) {
        return undefined;
      }

      return summary;
    } catch (error) {
      const condition =
        error instanceof SyntaxError ? 'corrupt' : 'unavailable';
      log.warn(
        `Ignoring ${condition} summary cache for ${streamId}; rebuilding from the stream log: ${toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private summarizeEntries(
    entries: readonly StreamLogEntry[],
  ): StreamLogSummary {
    return toSummary({
      firstTimestamp: entries[0]?.timestamp,
      lastTimestamp: entries.at(-1)?.timestamp,
      hasRunningGroup: entries.some(isRunningGroupEntry),
      hasRunningStreamingText: entries.some(isRunningStreamingTextEntry),
      hasNonterminalWorkflowCall: entries.some(
        (entry) => nonterminalWorkflowCall(entry) !== undefined,
      ),
    });
  }

  async maintainSummaryCache(
    streamId: StreamTabId,
    summary: StreamLogSummary,
  ): Promise<void> {
    if (!this.persistent || !this.summaryCacheMaintenanceEnabled) {
      return;
    }
    try {
      await this.summariesKv.write(streamId, summary);
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to write transcript summary cache for ${streamId}: ${toErrorMessage(error)}`,
      );
    }
  }

  async deleteSummaryCache(streamId: StreamTabId): Promise<void> {
    if (!this.summaryCacheMaintenanceEnabled) return;
    try {
      await this.summariesKv.delete(streamId);
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to delete transcript summary cache for ${streamId}: ${toErrorMessage(error)}`,
      );
    }
  }

  async clearSummaryCache(): Promise<void> {
    if (!this.summaryCacheMaintenanceEnabled) return;
    try {
      await this.summariesKv.deleteDir();
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to clear transcript summary cache: ${toErrorMessage(error)}`,
      );
    }
  }

  private disableSummaryCacheMaintenance(message: string): void {
    if (!this.summaryCacheMaintenanceEnabled) return;
    this.summaryCacheMaintenanceEnabled = false;
    log.warn(message);
  }
}
