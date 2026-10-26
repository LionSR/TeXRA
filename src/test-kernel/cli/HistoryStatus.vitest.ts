import '@test/support/sessionGraphTestSetup';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import { Effect, Schema } from 'effect';

import { registerRun } from '@agent/storage/runLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  cliRunStanding,
  HISTORY_RUN_STATUS,
} from '@cli/runtime/toolUseResumeData';
import {
  formatCliHistoryDetailsText,
  listResumableCliHistoryEntries,
  readCliHistoryDetails,
} from '@cli/runtime/history';
import { withProcessServices } from '@platform/processRuntime';
import { AgentConfigSchema, qualifyAggregateId } from '@shared/schemas';
import type { RunId, RunOutcome } from '@shared/schemas';
import { seedRows } from '@test/support/sessionTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import {
  closeTestDefaultSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';

const TOOL_USE_CONFIG: AgentConfig = Schema.decodeUnknownSync(
  AgentConfigSchema,
)({
  agent: 'orchestrator',
  model: 'deepseek/deepseek-v4-flash',
  instruction: 'Continue the session.',
  workingDirectory: '/workspace',
});

const tempDirs = useTempDirs();
setupPlatform(() => createTempDirPlatform('texra-history-status-', tempDirs));

beforeEach(async () => {
  await Effect.runPromise(closeTestDefaultSession);
  await Effect.runPromise(
    openTestDefaultSession({ roots: testWorkspaceRoots() }),
  );
});

/** Commits the position that opens a run — the fact resume reads — then releases its lease. */
async function seedSnapshot(
  id: RunId,
  config: AgentConfig,
  agent: string,
): Promise<void> {
  await Effect.runPromise(
    registerRun(testDefaultSession(), id, config, {
      identity: { kind: 'agent', agent },
    }),
  );
  await Effect.runPromise(
    seedRows(testDefaultSession().log)([
      {
        type: 'run.position',
        aggregateId: qualifyAggregateId('run', id),
        payload: { family: 'toolUse', at: 'turn.ready', turn: 0 },
      },
    ]),
  );
}

describe('CLI history status formatting', () => {
  /** The frozen status mapping alone. */
  const statusOf = (resumable: boolean, phase?: RunOutcome): string =>
    cliRunStanding({ resumable, phase }).status;

  it('keeps failed terminal outcomes in the frozen status even when resumable', () => {
    expect(statusOf(false, 'failed')).toBe('failed');
    // The NDJSON `status` field is frozen; a failed run that can continue is
    // offered through the sibling `resumable` boolean instead.
    expect(statusOf(true, 'failed')).toBe('failed');
  });

  it('filters history entries by the resumable flag, not the status', () => {
    expect(
      listResumableCliHistoryEntries([
        { id: 'resume-me', resumable: true },
        { id: 'done', resumable: false },
        { id: 'errored-with-checkpoint', resumable: true },
      ] as const),
    ).toEqual([
      { id: 'resume-me', resumable: true },
      { id: 'errored-with-checkpoint', resumable: true },
    ]);
  });

  it('never lets blocked runs push a resumable run off the list', () => {
    const blocked = Array.from({ length: 60 }, (_, index) => ({
      id: `blocked-${index}`,
      resumable: false,
      resumeBlocked: 'written by an earlier build',
    }));
    const listed = listResumableCliHistoryEntries([
      ...blocked,
      { id: 'older-resumable', resumable: true },
    ]);
    expect(listed.filter((entry) => entry.resumable)).toEqual([
      { id: 'older-resumable', resumable: true },
    ]);
    expect(listed.filter((entry) => !entry.resumable)).toHaveLength(10);
  });

  // `status` is a frozen contract, so `history show` answers it from the same
  // facts as `history list`: `deriveResumability` and the folded status. A run the resume path later refuses is still
  // advertised here and refused, in its own words, on open — what it must
  // never become is 'completed' (the crash-masking guard).
  it.effect(
    'advertises a run with a snapshot, and never calls it completed',
    () =>
      Effect.gen(function* () {
        const id = 'bad-f10' as RunId;
        yield* Effect.promise(() =>
          seedSnapshot(id, TOOL_USE_CONFIG, 'orchestrator'),
        );

        const details = yield* withProcessServices(
          testRuntime(),
          readCliHistoryDetails(
            Effect.sync(() => testSessionOf(testDefaultSession())),
            id,
          ),
        );

        expect(details?.checkpointPresent).toBe(true);
        expect(details?.status).toBe(HISTORY_RUN_STATUS.RESUMABLE);
        expect(details?.status).not.toBe('completed');
        expect(formatCliHistoryDetailsText(details!)).toContain(
          'Checkpoint: present',
        );
      }),
  );
});
