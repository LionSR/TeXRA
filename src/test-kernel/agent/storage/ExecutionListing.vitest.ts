import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
async function writeMetadata(
  id: ExecutionId,
  meta: Omit<ExecutionMeta, 'schemaVersion'>,
): Promise<void> {
  const existing = await Effect.runPromise(
    getExecutionRecords(session, id).readMeta(),
  );
  const streamId = (meta.streamId ??
    existing?.streamId ??
    `stream-${id}`) as StreamTabId;
  if (!existing) {
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(meta.timestamp));
    try {
      await Effect.runPromise(
        session.commit([
          {
            type: 'run.start',
            aggregateId: aggregateId('stream', streamId),
            executionId: id,
            identity: meta.identity,
            category: 'toolUse',
            isRemote: false,
            userFollowUpSupport: 'unsupported',
            parentStreamId: meta.parentExecutionId
              ? (
                  await Effect.runPromise(
                    getExecutionRecords(
                      session,
                      meta.parentExecutionId,
                    ).readMeta(),
                  )
                )?.streamId
              : undefined,
          },
        ]),
      );
    } finally {
      clock.mockRestore();
    }
  }
  if (meta.description)
    await Effect.runPromise(
      session.commit([
        {
          type: 'execution.description',
          aggregateId: aggregateId('execution', id),
          description: meta.description,
        },
      ]),
    );
  if (meta.outcome)
    await Effect.runPromise(
      session.commit([
        {
          type: 'status',
          aggregateId: aggregateId('stream', streamId),
          phase: meta.outcome,
          cause: 'test outcome',
        },
      ]),
    );
}
async function writeExecution(
  id: ExecutionId,
  timestamp: string,
  agentConfig?: AgentConfig,
  parentExecutionId?: ExecutionId,
): Promise<void> {
  await writeMetadata(id, {
    timestamp,
    parentExecutionId,
    ...(agentConfig
      ? { identity: { kind: 'agent', agent: agentConfig.agent } }
      : {}),
  });
  if (agentConfig)
    await Effect.runPromise(
      getExecutionRecords(session, id).writeRunRecord(agentConfig),
    );
}

describe('execution listing normalization', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
    session = createProcessSession();
  });

  it('sees executions written by another host after an earlier listing', async () => {
    expect(await Effect.runPromise(listExecutions(session))).toEqual([]);

    const id = 'eee555' as ExecutionId;
    await writeExecution(id, '2026-07-15T11:00:00.000Z', config('assistant'));

    expect(await Effect.runPromise(listExecutions(session))).toEqual([
      expect.objectContaining({
        id,
        kind: 'run',
        identity: { kind: 'agent', agent: 'assistant' },
      }),
    ]);
  });

  // A row is dropped only when the facts it is built from are unreadable. The
  // checkpoint probe is not one of them: it decides an advertisement, so a
  // failing `stat` costs the row its Resume affordance, never its place in
  // history.
  it('keeps a row whose checkpoint probe fails, without a checkpoint', async () => {
    const id = 'eee556' as ExecutionId;
    await writeExecution(id, '2026-07-15T11:00:00.000Z', config('assistant'));
    vi.spyOn(getExecutionStore(id), 'exists').mockRejectedValue(
      new Error('stat failed'),
    );

    expect(await Effect.runPromise(listExecutions(session))).toEqual([
      expect.objectContaining({ id, kind: 'run', checkpointPresent: false }),
    ]);
  });

  it('sees metadata replaced by another host after an earlier listing', async () => {
    const id = 'fff666' as ExecutionId;
    await writeExecution(id, '2026-07-15T12:00:00.000Z', config('assistant'));
    expect(await Effect.runPromise(listExecutions(session))).toEqual([
      expect.not.objectContaining({ description: expect.any(String) }),
    ]);

    await writeMetadata(id, {
      timestamp: '2026-07-15T12:00:00.000Z',
      description: 'Updated by another host',
      outcome: 'completed',
    });

    expect(await Effect.runPromise(listExecutions(session))).toEqual([
      expect.objectContaining({
        id,
        description: 'Updated by another host',
        outcome: 'completed',
      }),
    ]);
  });

  it('uses the config as the canonical source for visible agent fields', async () => {
    const id = 'aaa111' as ExecutionId;
    const agentConfig = config('assistant');
    await writeExecution(id, '2026-07-15T10:00:00.000Z', agentConfig);

    const entries = await Effect.runPromise(listExecutions(session));

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
  });

  it('classifies process and incomplete storage rows explicitly', async () => {
    const processId = 'bbb222' as ExecutionId;
    const customBashAgentId = 'ccc333' as ExecutionId;
    const incompleteId = 'ddd444' as ExecutionId;
    const processStore = getExecutionRecords(session, processId);
    await writeMetadata(processId, {
      timestamp: '2026-07-15T09:00:00.000Z',
      identity: { kind: 'process', tool: 'assistant' },
    });
    await Effect.runPromise(processStore.writeRunRecord(config('assistant')));
    await writeExecution(
      customBashAgentId,
      '2026-07-15T08:00:00.000Z',
      config('bash'),
    );
    await writeExecution(incompleteId, '2026-07-15T07:00:00.000Z');

    const entries = await Effect.runPromise(listExecutions(session));

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
  });

  it('lists an honest non-agent record as kind run without fabricated fields', async () => {
    const id = 'abe001' as ExecutionId;
    const store = getExecutionRecords(session, id);
    await writeMetadata(id, {
      timestamp: '2026-07-15T04:00:00.000Z',
      identity: { kind: 'process', tool: 'bash' },
    });
    await Effect.runPromise(
      store.writeRunRecord({ name: 'bash', instruction: 'ls -la' }),
    );

    const entries = await Effect.runPromise(listExecutions(session));
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
  });

  it('lists an identity-less row as incomplete and never heals it', async () => {
    // Rows registered before identity stamping lost their reader (#9590
    // Stage 7): no derivation from config or stream-id prefixes, no
    // write-back healing. They degrade to `incomplete`.
    const firstId = 'abc777' as ExecutionId;
    const secondId = 'abc778' as ExecutionId;
    for (const id of [firstId, secondId]) {
      const store = getExecutionRecords(session, id);
      await writeMetadata(id, { timestamp: '2026-07-15T06:00:00.000Z' });
      await Effect.runPromise(store.writeRunRecord(config('assistant')));
    }

    const entries = await Effect.runPromise(listExecutions(session));

    expect(entries.map(({ kind }) => kind)).toEqual([
      'incomplete',
      'incomplete',
    ]);
    // The row stays unstamped on disk: readers never reconstruct identity.
    expect(
      (
        await Effect.runPromise(
          getExecutionRecords(session, firstId).readMeta(),
        )
      )?.identity,
    ).toBeUndefined();
  });

  it('lists a pre-PR team-run config with the legacy delegation-scope pair as kind run', async () => {
    // Realistic team-run config.json written before the category-keyed
    // delegation-scope record (#8403 era): the scope is the old
    // workflowAgentKeys/toolUseAgentKeys pair. It must normalize at the
    // parse entrance, not fail AgentConfigSchema and list as incomplete.
    const id = 'abc888' as ExecutionId;
    const legacyTeamRunConfig = {
      agent: 'orchestrator',
      model: 'deepseekT',
      instruction: 'Coordinate the team.',
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: '/workspace',
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: {
        workflowAgentKeys: ['correct', 'polish'],
        toolUseAgentKeys: ['research', 'review'],
      },
    };
    const store = getExecutionRecords(session, id);
    await writeMetadata(id, {
      timestamp: '2026-07-15T05:00:00.000Z',
      identity: { kind: 'agent', agent: 'orchestrator' },
    });
    // Persist the raw legacy bytes, bypassing the current input type.
    await Effect.runPromise(
      store.writeRunRecord(legacyTeamRunConfig as unknown as AgentConfig),
    );

    const entries = await Effect.runPromise(listExecutions(session));
    const entry = entries.find((candidate) => candidate.id === id);
    expect(entry).toMatchObject({
      kind: 'run',
      identity: { kind: 'agent', agent: 'orchestrator' },
      record: {
        agent: 'orchestrator',
        delegationAgentScope: {
          workflow: ['correct', 'polish'],
          toolUse: ['research', 'review'],
        },
      },
    });
  });

  it('keeps agent-spawned child runs out of history listings', async () => {
    const rootId = 'eee111' as ExecutionId;
    const childId = 'fff222' as ExecutionId;
    await writeExecution(
      rootId,
      '2026-07-15T10:00:00.000Z',
      config('orchestrator'),
    );
    await writeExecution(
      childId,
      '2026-07-15T10:05:00.000Z',
      config('search'),
      rootId,
    );

    const entries = await Effect.runPromise(listExecutions(session));

    // The raw listing still carries the child so tool-facing callers can walk
    // the lineage; only the history-listing filter drops it.
    expect(entries.map(({ id }) => id)).toEqual([childId, rootId]);
    expect(entries.filter(isUserVisibleExecution).map(({ id }) => id)).toEqual([
      rootId,
    ]);
  });

  it('projects agent runs and stream ids for latexdiff execution discovery', async () => {
    const rootId = 'ab1001' as ExecutionId;
    const childId = 'ab1002' as ExecutionId;
    const processId = 'ab1003' as ExecutionId;
    const rootStore = getExecutionRecords(session, rootId);
    await writeMetadata(rootId, {
      timestamp: '2026-07-15T10:00:00.000Z',
      identity: { kind: 'agent', agent: 'assistant' },
      streamId: 'assistant@deepseekT#ab1001',
    });
    await Effect.runPromise(
      rootStore.writeRunRecord(config('assistant', ['main.tex'])),
    );
    await writeExecution(
      childId,
      '2026-07-15T09:00:00.000Z',
      config('delegated', ['child.tex']),
      rootId,
    );
    const processStore = getExecutionRecords(session, processId);
    await writeMetadata(processId, {
      timestamp: '2026-07-15T08:00:00.000Z',
      identity: { kind: 'process', tool: 'bash' },
    });
    await Effect.runPromise(
      processStore.writeRunRecord({ name: 'bash', instruction: 'ls -la' }),
    );

    const discovery = createLatexExecutionDiscovery(session);

    // Unlike a history listing, latexdiff discovery keeps delegated children
    // and drops non-agent rows.
    expect(await Effect.runPromise(discovery.listAgentRuns())).toEqual([
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
    expect(await Effect.runPromise(discovery.readStreamId(rootId))).toBe(
      'assistant@deepseekT#ab1001',
    );
    expect(await Effect.runPromise(discovery.readStreamId(childId))).toBe(
      `stream-${childId}`,
    );
  });
});
