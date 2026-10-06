import '@test/support/sessionGraphTestSetup';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import { Effect } from 'effect';

import { registerRun } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { cliRunStanding } from '@cli/runtime/toolUseResumeData';
import {
  formatCliHistoryDetailsText,
  listResumableCliHistoryEntries,
  readCliHistoryDetails,
} from '@cli/runtime/history';
import { withProcessServices } from '@platform/processRuntime';
import {
  aggregateId,
  CLI_RUN_STATUS,
  RunSnapshotPayloadSchema,
  HISTORY_RUN_STATUS,
} from '@shared/schemas';
import type { RunSnapshotPayload, RunId, RunOutcome } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
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
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';

const TOOL_USE_CONFIG: AgentConfig = AgentConfigSchema.parse({
  agent: 'orchestrator',
  model: 'deepseek/deepseek-v4-flash',
  instruction: 'Continue the session.',
  workingDirectory: '/workspace',
});
const WORKFLOW_CONFIG: AgentConfig = AgentConfigSchema.parse(
  documentTaskConfig({
    ...TOOL_USE_CONFIG,
    agent: 'correct',
    instruction: 'Continue the workflow.',
  }),
);

const tempDirs = useTempDirs();
setupPlatform(() => createTempDirPlatform('texra-history-status-', tempDirs));

beforeEach(async () => {
  await Effect.runPromise(closeTestDefaultSession);
  await Effect.runPromise(
    openTestDefaultSession({ roots: testWorkspaceRoots() }),
  );
});

const SNAPSHOT_RUNTIME = {
  modelId: 'deepseek/deepseek-v4-flash',
  backend: 'deepseek',
  lastError: null,
  declinedRoutes: [],
};

/** A run's opening `run.snapshot`. */
function snapshotPayload(): RunSnapshotPayload {
  return RunSnapshotPayloadSchema.parse({
    family: 'toolUse',
    runtime: SNAPSHOT_RUNTIME,
    state: { stateSlices: null },
  });
}

/** Commits a run's opening snapshot — the fact resume reads — then releases its lease. */
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
    testDefaultSession().commit([
      {
        type: 'run.snapshot',
        aggregateId: aggregateId('run', id),
        payload: snapshotPayload(),
      },
    ]),
  );
  await Effect.runPromise(testDefaultSession().commitRunEnd(id));
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

  it('marks resumable cancelled runs as resumable', () => {
    expect(statusOf(true, 'cancelled')).toBe(HISTORY_RUN_STATUS.RESUMABLE);
  });

  it('marks resumable runs without a terminal outcome as resumable', () => {
    expect(statusOf(true)).toBe(HISTORY_RUN_STATUS.RESUMABLE);
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

  it('reports outcome-free entries as unknown when they cannot resume', () => {
    // A missing terminal outcome means the terminal write never happened
    // (crash, kill, old build) — reporting 'completed' would mask crashes.
    expect(statusOf(false)).toBe('unknown');
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
          readCliHistoryDetails(Effect.succeed(testDefaultSession()), id),
        );

        expect(details?.checkpointPresent).toBe(true);
        expect(details?.status).toBe(HISTORY_RUN_STATUS.RESUMABLE);
        expect(details?.status).not.toBe(CLI_RUN_STATUS.COMPLETED);
        expect(formatCliHistoryDetailsText(details!)).toContain(
          'Checkpoint: present',
        );
      }),
  );

  it.effect('marks document task snapshots as CLI-resumable', () =>
    Effect.gen(function* () {
      const id = 'c0ffee-f10' as RunId;
      yield* Effect.promise(() => seedSnapshot(id, WORKFLOW_CONFIG, 'correct'));

      const details = yield* withProcessServices(
        testRuntime(),
        readCliHistoryDetails(Effect.succeed(testDefaultSession()), id),
      );

      expect(details?.checkpointPresent).toBe(true);
      expect(details?.status).toBe(HISTORY_RUN_STATUS.RESUMABLE);
      expect(formatCliHistoryDetailsText(details!)).toContain(
        'Checkpoint: present',
      );
    }),
  );

  // A checkpoint alone is not enough: without a config there is nothing to
  // resume and nothing for a host to adopt, so the row says so.
  it.effect('does not offer a run whose config is missing as resumable', () =>
    Effect.gen(function* () {
      const id = 'baad-c0f' as RunId;
      yield* testDefaultSession().commit([
        {
          type: 'run.start',
          aggregateId: aggregateId('run', id),
          identity: { kind: 'agent', agent: 'orchestrator' },
          userFollowUpSupport: 'unsupported',
          parent: null,
          provenance: null,
        },
      ]);
      yield* testDefaultSession().commit([
        {
          type: 'run.snapshot',
          aggregateId: aggregateId('run', id),
          payload: snapshotPayload(),
        },
      ]);

      const details = yield* withProcessServices(
        testRuntime(),
        readCliHistoryDetails(Effect.succeed(testDefaultSession()), id),
      );

      expect(details?.checkpointPresent).toBe(true);
      expect(details?.status).not.toBe(HISTORY_RUN_STATUS.RESUMABLE);
    }),
  );
});
