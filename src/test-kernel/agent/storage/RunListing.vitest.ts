import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLatexRunDiscovery,
  getRunRecords,
  isUserVisibleRun,
  listRuns,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import * as logger from '@logger/logUtils';
import { DatabaseReadFailed } from '@shared/session/database';
import {
  aggregateId,
  emptyRunEndOutput,
  type RunId,
  type RunIdentity,
  type RunOutcome,
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
    instruction: 'Test run listing.',
    agentCategory: AgentCategory.ToolUse,
    workingDirectory: '/workspace',
    inputFiles,
  });
}

let session: SessionHandle;
/** The run facts a listing row is built from, as the rows that carry them. */
type SeededRunFacts = {
  readonly timestamp: string;
  readonly identity: RunIdentity;
  readonly parentRunId?: RunId;
  readonly description?: string;
  readonly outcome?: RunOutcome;
};
async function writeMetadata(id: RunId, meta: SeededRunFacts): Promise<void> {
  const existing = await Effect.runPromise(getRunRecords(session, id).exists());
  if (!existing) {
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(meta.timestamp));
    try {
      await Effect.runPromise(
        session.commit([
          {
            type: 'run.start',
            aggregateId: aggregateId('run', id),
            identity: meta.identity,
            category: 'toolUse',
            isRemote: false,
            userFollowUpSupport: 'unsupported',
            parent:
              meta.parentRunId === undefined ? null : { id: meta.parentRunId },
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
          type: 'run.description',
          aggregateId: aggregateId('run', id),
          description: meta.description,
        },
      ]),
    );
  if (meta.outcome)
    await Effect.runPromise(
      session.commit([
        {
          type: 'run.end',
          aggregateId: aggregateId('run', id),
          outcome: meta.outcome,
          output: emptyRunEndOutput(AgentCategory.ToolUse),
        },
      ]),
    );
}
async function writeRun(
  id: RunId,
  timestamp: string,
  agentConfig?: AgentConfig,
  parentRunId?: RunId,
): Promise<void> {
  await writeMetadata(id, {
    timestamp,
    parentRunId,
    identity: { kind: 'agent', agent: agentConfig?.agent ?? 'assistant' },
  });
  if (agentConfig)
    await Effect.runPromise(
      getRunRecords(session, id).writeRunRecord(agentConfig),
    );
}

describe('run listing normalization', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    session = createProcessSession();
  });

  it('sees runs written by another host after an earlier listing', async () => {
    expect(await Effect.runPromise(listRuns(session))).toEqual([]);

    const id = 'eee555' as RunId;
    await writeRun(id, '2026-07-15T11:00:00.000Z', config('assistant'));

    expect(await Effect.runPromise(listRuns(session))).toEqual([
      expect.objectContaining({
        id,
        kind: 'run',
        identity: { kind: 'agent', agent: 'assistant' },
      }),
    ]);
  });

  // A row is dropped only when the facts it is built from are unreadable. The
  // checkpoint probe is not one of them: it decides an advertisement, so an
  // unreadable snapshot costs the row its Resume affordance, never its place
  // in history.
  it('keeps a row whose checkpoint probe fails, without a checkpoint', async () => {
    const id = 'eee556' as RunId;
    await writeRun(id, '2026-07-15T11:00:00.000Z', config('assistant'));
    vi.spyOn(session.ledger, 'latestSnapshot').mockReturnValue(
      Effect.fail(
        new DatabaseReadFailed({
          path: 'session.db',
          cause: new Error('snapshot read failed'),
        }),
      ),
    );

    expect(await Effect.runPromise(listRuns(session))).toEqual([
      expect.objectContaining({ id, kind: 'run', checkpointPresent: false }),
    ]);
  });

  it('sees metadata replaced by another host after an earlier listing', async () => {
    const id = 'fff666' as RunId;
    await writeRun(id, '2026-07-15T12:00:00.000Z', config('assistant'));
    expect(await Effect.runPromise(listRuns(session))).toEqual([
      expect.not.objectContaining({ description: expect.any(String) }),
    ]);

    await writeMetadata(id, {
      timestamp: '2026-07-15T12:00:00.000Z',
      identity: { kind: 'agent', agent: 'assistant' },
      description: 'Updated by another host',
      outcome: 'completed',
    });

    expect(await Effect.runPromise(listRuns(session))).toEqual([
      expect.objectContaining({
        id,
        description: 'Updated by another host',
        outcome: 'completed',
      }),
    ]);
  });

  it('uses the config as the canonical source for visible agent fields', async () => {
    const id = 'aaa111' as RunId;
    const agentConfig = config('assistant');
    await writeRun(id, '2026-07-15T10:00:00.000Z', agentConfig);

    const entries = await Effect.runPromise(listRuns(session));

    expect(entries).toEqual([
      {
        kind: 'run',
        id,
        timestamp: '2026-07-15T10:00:00.000Z',
        identity: { kind: 'agent', agent: 'assistant' },
        record: agentConfig,
        checkpointPresent: false,
      },
    ]);
    expect(entries.filter(isUserVisibleRun)).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('agent');
    expect(entries[0]).not.toHaveProperty('model');
    expect(entries[0]).not.toHaveProperty('category');
  });

  it('classifies process and incomplete storage rows explicitly', async () => {
    const processId = 'bbb222' as RunId;
    const customBashAgentId = 'ccc333' as RunId;
    const incompleteId = 'ddd444' as RunId;
    const processStore = getRunRecords(session, processId);
    await writeMetadata(processId, {
      timestamp: '2026-07-15T09:00:00.000Z',
      identity: { kind: 'process', tool: 'assistant' },
    });
    await Effect.runPromise(processStore.writeRunRecord(config('assistant')));
    await writeRun(
      customBashAgentId,
      '2026-07-15T08:00:00.000Z',
      config('bash'),
    );
    await writeRun(incompleteId, '2026-07-15T07:00:00.000Z');

    const entries = await Effect.runPromise(listRuns(session));

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
      timestamp: '2026-07-15T07:00:00.000Z',
      checkpointPresent: false,
    });
    expect(entries.filter(isUserVisibleRun)).toEqual([entries[1]]);
  });

  it('lists an honest non-agent record as kind run without fabricated fields', async () => {
    const id = 'abe001' as RunId;
    const store = getRunRecords(session, id);
    await writeMetadata(id, {
      timestamp: '2026-07-15T04:00:00.000Z',
      identity: { kind: 'process', tool: 'bash' },
    });
    await Effect.runPromise(
      store.writeRunRecord({ name: 'bash', instruction: 'ls -la' }),
    );

    const entries = await Effect.runPromise(listRuns(session));
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
    expect(entries.filter(isUserVisibleRun)).toHaveLength(0);
  });

  it('keeps agent-spawned child runs out of history listings', async () => {
    const rootId = 'eee111' as RunId;
    const childId = 'fff222' as RunId;
    await writeRun(rootId, '2026-07-15T10:00:00.000Z', config('orchestrator'));
    await writeRun(
      childId,
      '2026-07-15T10:05:00.000Z',
      config('search'),
      rootId,
    );

    const entries = await Effect.runPromise(listRuns(session));

    // The raw listing still carries the child so tool-facing callers can walk
    // the lineage; only the history-listing filter drops it.
    expect(entries.map(({ id }) => id)).toEqual([childId, rootId]);
    expect(entries.filter(isUserVisibleRun).map(({ id }) => id)).toEqual([
      rootId,
    ]);
  });

  it('projects agent runs for latexdiff run discovery', async () => {
    const rootId = 'ab1001' as RunId;
    const childId = 'ab1002' as RunId;
    const processId = 'ab1003' as RunId;
    const rootStore = getRunRecords(session, rootId);
    await writeMetadata(rootId, {
      timestamp: '2026-07-15T10:00:00.000Z',
      identity: { kind: 'agent', agent: 'assistant' },
    });
    await Effect.runPromise(
      rootStore.writeRunRecord(config('assistant', ['main.tex'])),
    );
    await writeRun(
      childId,
      '2026-07-15T09:00:00.000Z',
      config('delegated', ['child.tex']),
      rootId,
    );
    const processStore = getRunRecords(session, processId);
    await writeMetadata(processId, {
      timestamp: '2026-07-15T08:00:00.000Z',
      identity: { kind: 'process', tool: 'bash' },
    });
    await Effect.runPromise(
      processStore.writeRunRecord({ name: 'bash', instruction: 'ls -la' }),
    );

    const discovery = createLatexRunDiscovery(session);

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
  });
});
