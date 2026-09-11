/** Read output metadata from the root's event fold for a matching run. */
import * as path from 'node:path';
import { Effect } from 'effect';

import type {
  RunId,
  OutputFileInfo,
  ReadonlyRoundIndexed,
} from '@shared/schemas';
import type { RunSnapshotStore } from '@transcript/RunSnapshotStore';
import { toNewestFirstByTimestamp } from '@utils/core';
import {
  scanRunDirForOutputs,
  type RunOutputFilesystem,
} from './runOutputFiles';
import type { LatexRunDiscoveryPort } from './runDiscovery';

/**
 * When the caller didn't supply `outputsByRound`, look up the most recent
 * run whose `agent + model + inputFile` match the request and pull
 * its persisted `OutputFileInfo[]` from the stream-tab store. Returns null
 * when no matching run exists.
 */
export const discoverLatestRunOutputs = Effect.fn('discoverLatestRunOutputs')(
  function* (
    discovery: LatexRunDiscoveryPort,
    snapshots: Pick<RunSnapshotStore, 'read'>,
    query: {
      agent: string;
      model: string;
      inputFile: string;
    },
    channel: string,
    filesystem: RunOutputFilesystem,
  ): Effect.fn.Return<
    {
      runId: RunId;
      rounds: ReadonlyRoundIndexed<OutputFileInfo>;
    } | null,
    Error
  > {
    const runs = yield* discovery.listAgentRuns();
    // Normalize both sides so trivial path-format differences (duplicate
    // separators, `./`, mixed forward/backslash) don't silently miss a
    // matching run.
    const normalizedInput = path.normalize(query.inputFile);

    const candidates = toNewestFirstByTimestamp(
      runs.filter((entry) => {
        if (entry.agent !== query.agent || entry.model !== query.model) {
          return false;
        }
        const entryInput = entry.inputFiles[0];
        return (
          typeof entryInput === 'string' &&
          path.normalize(entryInput) === normalizedInput
        );
      }),
      (entry) => entry.timestamp,
    );

    for (const candidate of candidates) {
      // The run id addresses its snapshot directly; identity is never rebuilt
      // from agent/model configuration.
      const { outputFilesByRound: rounds } = yield* snapshots.read(
        candidate.id,
      );
      if (Object.keys(rounds).length > 0) {
        return { runId: candidate.id, rounds };
      }
      // Generated files remain discoverable when no output facts were recorded.
      // Use all configured input files as diff bases, as the pinned-run path does.
      const scanned = yield* scanRunDirForOutputs(
        candidate.id,
        query.inputFile,
        candidate.inputFiles.slice(1),
        channel,
        filesystem,
      );
      if (scanned) {
        return { runId: candidate.id, rounds: scanned };
      }
    }
    return null;
  },
);
