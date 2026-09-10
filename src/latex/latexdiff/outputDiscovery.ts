/** Read output metadata from the root's event fold for a matching execution. */
import * as path from 'node:path';
import { Effect } from 'effect';

import type {
  ExecutionId,
  OutputFileInfo,
  ReadonlyRoundIndexed,
} from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript/StreamSnapshotStore';
import { toNewestFirstByTimestamp } from '@utils/core';
import {
  scanRunDirForOutputs,
  type RunOutputFilesystem,
} from './runOutputFiles';
import type { LatexExecutionDiscoveryPort } from './executionDiscovery';

/**
 * When the caller didn't supply `outputsByRound`, look up the most recent
 * execution whose `agent + model + inputFile` match the request and pull
 * its persisted `OutputFileInfo[]` from the stream-tab store. Returns null
 * when no matching execution exists.
 */
export const discoverLatestExecutionOutputs = Effect.fn(
  'discoverLatestExecutionOutputs',
)(function* (
  discovery: LatexExecutionDiscoveryPort,
  snapshots: Pick<StreamSnapshotStore, 'read'>,
  query: {
    agent: string;
    model: string;
    inputFile: string;
  },
  channel: string,
  filesystem: RunOutputFilesystem,
): Effect.fn.Return<
  {
    executionId: ExecutionId;
    rounds: ReadonlyRoundIndexed<OutputFileInfo>;
  } | null,
  Error
> {
  const executions = yield* discovery.listAgentRuns();
  // Normalize both sides so trivial path-format differences (duplicate
  // separators, `./`, mixed forward/backslash) don't silently miss a
  // matching execution.
  const normalizedInput = path.normalize(query.inputFile);

  const candidates = toNewestFirstByTimestamp(
    executions.filter((entry) => {
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
    // The stream stamped on execution metadata addresses its snapshot
    // directly; identity is never rebuilt from agent/model configuration.
    // Records without one go straight to the run-directory scan below.
    const streamId = yield* discovery.readStreamId(candidate.id);
    if (streamId !== undefined) {
      const { outputFilesByRound: rounds } = yield* snapshots.read(streamId);
      if (Object.keys(rounds).length > 0) {
        return { executionId: candidate.id, rounds };
      }
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
      return { executionId: candidate.id, rounds: scanned };
    }
  }
  return null;
});
