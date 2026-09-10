import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import {
  clearStoreCache,
  createLatexExecutionDiscovery,
  getExecutionStore,
  getExecutionRecords,
  isUserVisibleExecution,
  listExecutions,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import * as logger from '@logger/logUtils';
import {
  aggregateId,
  type ExecutionId,
  type ExecutionMeta,
  type StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

function config(
  agent: string,
  inputFiles: readonly string[] = [],
): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model: 'deepseekT',
    instruction: 'Test execution listing.',
    agentCategory: AgentCategory.ToolUse,
    workingDirectory: '/workspace',
    inputFiles,
  });
}

let session: SessionHandle;
const writeMetadata = (
  id: ExecutionId,
  meta: Omit<ExecutionMeta, 'schemaVersion' | 'streamId'> & {
    streamId?: StreamTabId;
  },
) =>
  Effect.gen(function* () {
    const existing = yield* getExecutionRecords(session, id).readMeta();
    const streamId = (meta.streamId ??
      existing?.streamId ??
      `stream-${id}`) as StreamTabId;
    if (!existing) {
      const clock = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Date.parse(meta.timestamp));
      yield* Effect.gen(function* () {
        const parentStreamId = meta.parentExecutionId
          ? (yield* getExecutionRecords(
              session,
              meta.parentExecutionId,
            ).readMeta())?.streamId
          : undefined;
        yield* session.commit([
          {
            type: 'run.start',
            aggregateId: aggregateId('stream', streamId),
            executionId: id,
            identity: meta.identity,
            category: 'toolUse',
            isRemote: false,
            userFollowUpSupport: 'unsupported',
            parentStreamId,
          },
        ]);
      }).pipe(Effect.ensuring(Effect.sync(() => clock.mockRestore())));
    }
    if (meta.description)
      yield* session.commit([
        {
          type: 'execution.description',
          aggregateId: aggregateId('execution', id),
          description: meta.description,
        },
      ]);
    if (meta.outcome)
      yield* session.commit([
        {
          type: 'status',
          aggregateId: aggregateId('stream', streamId),
          phase: meta.outcome,
          cause: 'test outcome',
        },
      ]);
  });
const writeExecution = (
  id: ExecutionId,
  timestamp: string,
  agentConfig?: AgentConfig,
  parentExecutionId?: ExecutionId,
) =>
  Effect.gen(function* () {
    yield* writeMetadata(id, {
      timestamp,
      parentExecutionId,
      identity: { kind: 'agent', agent: agentConfig?.agent ?? 'assistant' },
    });
    if (agentConfig)
      yield* getExecutionRecords(session, id).writeRunRecord(agentConfig);
  });

describe('execution listing normalization', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
    session = createProcessSession();
  });

  // `it.live`, not `it.effect`: these rows pin their timestamps through
  // `vi.spyOn(Date, 'now')`, which the TestClock would override with 0.

  it.live(
    'sees executions written by another host after an earlier listing',
    () =>
      Effect.gen(function* () {
        expect(yield* listExecutions(session)).toEqual([]);

        const id = 'eee555' as ExecutionId;
        yield* writeExecution(
          id,
          '2026-07-15T11:00:00.000Z',
          config('assistant'),
        );

        expect(yield* listExecutions(session)).toEqual([
          expect.objectContaining({
            id,
            kind: 'run',
            identity: { kind: 'agent', agent: 'assistant' },
          }),
        ]);
      }),
  );

  // A row is dropped only when the facts it is built from are unreadable. The
  // checkpoint probe is not one of them: it decides an advertisement, so a
  // failing `stat` costs the row its Resume affordance, never its place in
  // history.
  it.live(
    'keeps a row whose checkpoint probe fails, without a checkpoint',
    () =>
      Effect.gen(function* () {
        const id = 'eee556' as ExecutionId;
        yield* writeExecution(
          id,
          '2026-07-15T11:00:00.000Z',
          config('assistant'),
        );
        vi.spyOn(getExecutionStore(id), 'exists').mockRejectedValue(
          new Error('stat failed'),
        );

        expect(yield* listExecutions(session)).toEqual([
          expect.objectContaining({
            id,
            kind: 'run',
            checkpointPresent: false,
          }),
        ]);
      }),
  );

  it.live(
    'sees metadata replaced by another host after an earlier listing',
    () =>
      Effect.gen(function* () {
        const id = 'fff666' as ExecutionId;
        yield* writeExecution(
          id,
          '2026-07-15T12:00:00.000Z',
          config('assistant'),
        );
        expect(yield* listExecutions(session)).toEqual([
          expect.not.objectContaining({ description: expect.any(String) }),
        ]);

        yield* writeMetadata(id, {
          timestamp: '2026-07-15T12:00:00.000Z',
          identity: { kind: 'agent', agent: 'assistant' },
          description: 'Updated by another host',
          outcome: 'completed',
        });

        expect(yield* listExecutions(session)).toEqual([
          expect.objectContaining({
            id,
            description: 'Updated by another host',
            outcome: 'completed',
          }),
        ]);
      }),
  );

  it.live(
    'uses the config as the canonical source for visible agent fields',
    () =>
      Effect.gen(function* () {
        const id = 'aaa111' as ExecutionId;
        const agentConfig = config('assistant');
        yield* writeExecution(id, '2026-07-15T10:00:00.000Z', agentConfig);

        const entries = yield* listExecutions(session);

        expect(entries).toEqual([
          {
            kind: 'run',
            id,
            timestamp: '2026-07-15T10:00:00.000Z',
            identity: { kind: 'agent', agent: 'assistant' },
            record: agentConfig,
            checkpointPresent: false,
            streamId: `stream-${id}`,
          },
        ]);
        expect(entries.filter(isUserVisibleExecution)).toHaveLength(1);
        expect(entries[0]).not.toHaveProperty('agent');
        expect(entries[0]).not.toHaveProperty('model');
        expect(entries[0]).not.toHaveProperty('category');
      }),
  );

  it.live('classifies process and incomplete storage rows explicitly', () =>
    Effect.gen(function* () {
      const processId = 'bbb222' as ExecutionId;
      const customBashAgentId = 'ccc333' as ExecutionId;
      const incompleteId = 'ddd444' as ExecutionId;
      const processStore = getExecutionRecords(session, processId);
      yield* writeMetadata(processId, {
        timestamp: '2026-07-15T09:00:00.000Z',
        identity: { kind: 'process', tool: 'assistant' },
      });
      yield* processStore.writeRunRecord(config('assistant'));
      yield* writeExecution(
        customBashAgentId,
        '2026-07-15T08:00:00.000Z',
        config('bash'),
      );
      yield* writeExecution(incompleteId, '2026-07-15T07:00:00.000Z');

      const entries = yield* listExecutions(session);

      expect(entries.map(({ kind }) => kind)).toEqual([
        'run',
        'run',
        'incomplete',
      ]);
      expect(entries[0]).toMatchObject({
        kind: 'run',
        identity: { kind: 'process', tool: 'assistant' },
        record: { agent: 'assistant' },
      });
      expect(entries[1]).toMatchObject({
        kind: 'run',
        identity: { kind: 'agent', agent: 'bash' },
        record: { agent: 'bash' },
      });
      expect(entries[2]).toEqual({
        kind: 'incomplete',
        id: incompleteId,
        streamId: `stream-${incompleteId}`,
        timestamp: '2026-07-15T07:00:00.000Z',
        checkpointPresent: false,
      });
      expect(entries.filter(isUserVisibleExecution)).toEqual([entries[1]]);
    }),
  );

  it.live(
    'lists an honest non-agent record as kind run without fabricated fields',
    () =>
      Effect.gen(function* () {
        const id = 'abe001' as ExecutionId;
        const store = getExecutionRecords(session, id);
        yield* writeMetadata(id, {
          timestamp: '2026-07-15T04:00:00.000Z',
          identity: { kind: 'process', tool: 'bash' },
        });
        yield* store.writeRunRecord({ name: 'bash', instruction: 'ls -la' });

        const entries = yield* listExecutions(session);
        const entry = entries.find((candidate) => candidate.id === id);
        expect(entry).toMatchObject({
          kind: 'run',
          identity: { kind: 'process', tool: 'bash' },
          record: { name: 'bash', instruction: 'ls -la' },
        });
        expect(entry && 'record' in entry && entry.record).not.toHaveProperty(
          'agentCategory',
        );
        expect(entry && 'record' in entry && entry.record).not.toHaveProperty(
          'model',
        );
        expect(entries.filter(isUserVisibleExecution)).toHaveLength(0);
      }),
  );

  it.live('keeps agent-spawned child runs out of history listings', () =>
    Effect.gen(function* () {
      const rootId = 'eee111' as ExecutionId;
      const childId = 'fff222' as ExecutionId;
      yield* writeExecution(
        rootId,
        '2026-07-15T10:00:00.000Z',
        config('orchestrator'),
      );
      yield* writeExecution(
        childId,
        '2026-07-15T10:05:00.000Z',
        config('search'),
        rootId,
      );

      const entries = yield* listExecutions(session);

      // The raw listing still carries the child so tool-facing callers can walk
      // the lineage; only the history-listing filter drops it.
      expect(entries.map(({ id }) => id)).toEqual([childId, rootId]);
      expect(
        entries.filter(isUserVisibleExecution).map(({ id }) => id),
      ).toEqual([rootId]);
    }),
  );

  it.live(
    'projects agent runs and stream ids for latexdiff execution discovery',
    () =>
      Effect.gen(function* () {
        const rootId = 'ab1001' as ExecutionId;
        const childId = 'ab1002' as ExecutionId;
        const processId = 'ab1003' as ExecutionId;
        const rootStore = getExecutionRecords(session, rootId);
        yield* writeMetadata(rootId, {
          timestamp: '2026-07-15T10:00:00.000Z',
          identity: { kind: 'agent', agent: 'assistant' },
          streamId: 'assistant@deepseekT#ab1001',
        });
        yield* rootStore.writeRunRecord(config('assistant', ['main.tex']));
        yield* writeExecution(
          childId,
          '2026-07-15T09:00:00.000Z',
          config('delegated', ['child.tex']),
          rootId,
        );
        const processStore = getExecutionRecords(session, processId);
        yield* writeMetadata(processId, {
          timestamp: '2026-07-15T08:00:00.000Z',
          identity: { kind: 'process', tool: 'bash' },
        });
        yield* processStore.writeRunRecord({
          name: 'bash',
          instruction: 'ls -la',
        });

        const discovery = createLatexExecutionDiscovery(session);

        // Unlike a history listing, latexdiff discovery keeps delegated children
        // and drops non-agent rows.
        expect(yield* discovery.listAgentRuns()).toEqual([
          {
            id: rootId,
            timestamp: '2026-07-15T10:00:00.000Z',
            agent: 'assistant',
            model: 'deepseekT',
            inputFiles: ['main.tex'],
          },
          {
            id: childId,
            timestamp: '2026-07-15T09:00:00.000Z',
            agent: 'delegated',
            model: 'deepseekT',
            inputFiles: ['child.tex'],
          },
        ]);
        expect(yield* discovery.readStreamId(rootId)).toBe(
          'assistant@deepseekT#ab1001',
        );
        expect(yield* discovery.readStreamId(childId)).toBe(
          `stream-${childId}`,
        );
      }),
  );
});
