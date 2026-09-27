import '@test/support/sessionGraphTestSetup';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import { Effect } from 'effect';

import { registerRun } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  initializeDefaultSession,
  teardownDefaultSession,
} from '@agent/runtime/sessionGraph';
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
  AgentCategory,
  FlowSnapshotPayloadSchema,
  HISTORY_RUN_STATUS,
} from '@shared/schemas';
import type { FlowSnapshotPayload, RunId, RunOutcome } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';

const TOOL_USE_CONFIG: AgentConfig = AgentConfigSchema.parse({
  agent: 'orchestrator',
  model: 'deepseekT',
  instruction: 'Continue the session.',
  agentCategory: AgentCategory.ToolUse,
  workingDirectory: '/workspace',
});
const WORKFLOW_CONFIG: AgentConfig = AgentConfigSchema.parse({
  ...TOOL_USE_CONFIG,
  agent: 'correct',
  agentCategory: AgentCategory.Workflow,
  instruction: 'Continue the workflow.',
});

const tempDirs = useTempDirs();
setupPlatform(() => createTempDirPlatform('texra-history-status-', tempDirs));

beforeEach(async () => {
  await Effect.runPromise(teardownDefaultSession());
  await Effect.runPromise(
    initializeDefaultSession({ roots: testWorkspaceRoots() }),
  );
});

const SNAPSHOT_RUNTIME = {
  phase: 'waiting',
  round: 0,
  turn: 0,
  modelId: 'deepseekT',
  modelCompatibilityKey: null,
  lastError: null,
  declinedRoutes: [],
};

/** A run's opening `flow.snapshot`. */
function snapshotPayload(): FlowSnapshotPayload {
  return FlowSnapshotPayloadSchema.parse({
    family: 'toolUse',
    runtime: SNAPSHOT_RUNTIME,
    state: { stateSlices: null, offeredTools: [], toolsetHash: '0'.repeat(64) },
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
        type: 'flow.snapshot',
        aggregateId: aggregateId('run', id),
        payload: snapshotPayload(),
      },
    ]),
  );
  await Effect.runPromise(testDefaultSession().commitRunEnd(id));
}

describe('CLI history status formatting', () => {
  /** A tool-use run's standing: resumable exactly when it has a checkpoint,
   *  so the frozen status mapping is the only thing under test. */
  function statusOf(
    checkpointPresent: boolean,
    phase?: RunOutcome,
  ): Promise<string> {
    return Effect.runPromise(
      cliRunStanding(
        {
          id: 'abc123' as RunId,
          checkpointPresent,
          agentCategory: AgentCategory.ToolUse,
          phase,
        },
        testDefaultSession(),
      ),
    ).then((standing) => standing.status);
  }

  it('keeps failed terminal outcomes in the frozen status even with a checkpoint', async () => {
    await expect(statusOf(false, 'failed')).resolves.toBe('failed');
    // The NDJSON `status` field is frozen; a failed run that kept its
    // checkpoint is offered through the sibling `resumable` boolean instead.
    await expect(statusOf(true, 'failed')).resolves.toBe('failed');
  });

  it('marks interrupted tool-use sessions with flow records as resumable', async () => {
    await expect(statusOf(true, 'cancelled')).resolves.toBe(
      HISTORY_RUN_STATUS.RESUMABLE,
    );
  });

  it('marks flow records without a terminal outcome as resumable', async () => {
    await expect(statusOf(true)).resolves.toBe(HISTORY_RUN_STATUS.RESUMABLE);
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

  it('reports outcome-free entries as unknown when no flow remains', async () => {
    // A missing terminal outcome means the terminal write never happened
    // (crash, kill, old build) — reporting 'completed' would mask crashes.
    await expect(statusOf(false)).resolves.toBe('unknown');
  });

  // `status` is a frozen contract, so `history show` answers it from the same
  // facts as `history list`: the run's latest snapshot, its config, and the
  // terminal-rejection filter. A run the resume path later refuses is still
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

        expect(details?.hasFlowRecord).toBe(true);
        expect(details?.status).toBe(HISTORY_RUN_STATUS.RESUMABLE);
        expect(details?.status).not.toBe(CLI_RUN_STATUS.COMPLETED);
        expect(formatCliHistoryDetailsText(details!)).toContain(
          'Flow record: present',
        );
      }),
  );

  it.effect('marks workflow snapshots as CLI-resumable', () =>
    Effect.gen(function* () {
      const id = 'c0ffee-f10' as RunId;
      yield* Effect.promise(() => seedSnapshot(id, WORKFLOW_CONFIG, 'correct'));

      const details = yield* withProcessServices(
        testRuntime(),
        readCliHistoryDetails(Effect.succeed(testDefaultSession()), id),
      );

      expect(details?.hasFlowRecord).toBe(true);
      expect(details?.status).toBe(HISTORY_RUN_STATUS.RESUMABLE);
      expect(formatCliHistoryDetailsText(details!)).toContain(
        'Flow record: present',
      );
    }),
  );

  // A checkpoint alone is not enough: without a config there is no category
  // to resume under and nothing for a host to adopt, so the row says so.
  it.effect('does not offer a run whose config is missing as resumable', () =>
    Effect.gen(function* () {
      const id = 'baad-c0f' as RunId;
      yield* testDefaultSession().commit([
        {
          type: 'run.start',
          aggregateId: aggregateId('run', id),
          identity: { kind: 'agent', agent: 'orchestrator' },
          category: AgentCategory.ToolUse,
          userFollowUpSupport: 'unsupported',
          isRemote: false,
          parent: null,
        },
      ]);
      yield* testDefaultSession().commit([
        {
          type: 'flow.snapshot',
          aggregateId: aggregateId('run', id),
          payload: snapshotPayload(),
        },
      ]);

      const details = yield* withProcessServices(
        testRuntime(),
        readCliHistoryDetails(Effect.succeed(testDefaultSession()), id),
      );

      expect(details?.hasFlowRecord).toBe(true);
      expect(details?.status).not.toBe(HISTORY_RUN_STATUS.RESUMABLE);
    }),
  );
});
