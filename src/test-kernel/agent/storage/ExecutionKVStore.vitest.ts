import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import {
  clearStoreCache,
  EXECUTION_META_SCHEMA_VERSION,
  getExecutionStore,
  isReservedKvKeyName,
  type ResultMeta,
} from '@agent/storage';
import { clearTerminalExecutionState } from '@agent/storage/executionLifecycle';
import * as logger from '@logger/logUtils';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });

beforeEach(() => {
  clearStoreCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockWarn(): MockInstance<typeof logger.warn> {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

function expectParseWarning(
  warnSpy: MockInstance<typeof logger.warn>,
  id: ExecutionId,
  fileName: string,
): void {
  expect(warnSpy).toHaveBeenCalledWith(
    'ExecutionKVStore',
    expect.stringContaining(`Failed to parse execution ${id} ${fileName}`),
    { data: expect.any(Error) },
  );
}

// `isReservedKvKeyName` is the single owner of the reserved single-value-key
// and `child-` prefix vocabulary, exported so callers walking a run directory
// (e.g. `src/tools/executions/executionKvFiles.ts`) recognize it without
// re-deriving their own copy.
describe('isReservedKvKeyName', () => {
  it.each([
    'meta',
    'config',
    'report',
    'todos',
    'conversation',
    'workspace-files',
    'result-meta',
  ])('recognizes the reserved single-value key %s', (key) => {
    expect(isReservedKvKeyName(key)).toBe(true);
  });

  it('recognizes any child- prefixed key', () => {
    expect(isReservedKvKeyName('child-abc123')).toBe(true);
  });

  it('rejects keys outside the reserved vocabulary', () => {
    expect(isReservedKvKeyName('flow_abc123')).toBe(false);
    expect(isReservedKvKeyName('childish')).toBe(false);
    expect(isReservedKvKeyName('report-draft')).toBe(false);
  });
});

describe('ExecutionKVStore meta read shims', () => {
  it.each([
    [EXECUTION_STATUS.COMPLETED, RUN_OUTCOME.COMPLETED],
    [EXECUTION_STATUS.INTERRUPTED, RUN_OUTCOME.CANCELLED],
    [EXECUTION_STATUS.ERROR, RUN_OUTCOME.FAILED],
  ] as const)(
    'maps legacy terminalStatus %s to outcome %s',
    async (terminalStatus, outcome) => {
      const id = `legacy-${terminalStatus}` as ExecutionId;
      await getExecutionStore(id).write('meta', {
        timestamp: '2026-07-04T00:00:00.000Z',
        terminalStatus,
      });

      await expect(getExecutionStore(id).readMeta()).resolves.toMatchObject({
        schemaVersion: EXECUTION_META_SCHEMA_VERSION,
        terminalStatus,
        outcome,
      });
    },
  );

  it.each(Object.values(RUN_OUTCOME) as RunOutcome[])(
    'preserves canonical outcome %s',
    async (outcome) => {
      const id = `canonical-${outcome}` as ExecutionId;
      await getExecutionStore(id).write('meta', {
        timestamp: '2026-07-04T00:00:00.000Z',
        outcome,
      });

      await expect(getExecutionStore(id).readMeta()).resolves.toMatchObject({
        schemaVersion: EXECUTION_META_SCHEMA_VERSION,
        outcome,
      });
    },
  );

  it('rejects contradictory terminal status and outcome metadata', async () => {
    const id = 'contradictory-terminal-meta' as ExecutionId;

    await expect(
      getExecutionStore(id).writeMeta({
        timestamp: '2026-07-04T00:00:00.000Z',
        terminalStatus: EXECUTION_STATUS.COMPLETED,
        outcome: RUN_OUTCOME.FAILED,
      }),
    ).rejects.toThrow('outcome failed contradicts terminalStatus completed');
  });

  it('writes the current schema version for execution meta', async () => {
    const id = 'versioned-meta' as ExecutionId;

    await getExecutionStore(id).writeMeta({
      timestamp: '2026-07-04T00:00:00.000Z',
    });

    await expect(getExecutionStore(id).read('meta')).resolves.toMatchObject({
      schemaVersion: EXECUTION_META_SCHEMA_VERSION,
      timestamp: '2026-07-04T00:00:00.000Z',
    });
  });

  it('ignores obsolete delegation depth in persisted metadata', async () => {
    const id = 'legacy-delegation-depth' as ExecutionId;
    await getExecutionStore(id).write('meta', {
      timestamp: '2026-07-04T00:00:00.000Z',
      parentExecutionId: 'abcdef',
      delegationDepth: 3,
    });

    await expect(getExecutionStore(id).readMeta()).resolves.toEqual({
      schemaVersion: EXECUTION_META_SCHEMA_VERSION,
      timestamp: '2026-07-04T00:00:00.000Z',
      parentExecutionId: 'abcdef',
    });
  });

  it('supersedes an interim result outcome with the durable cancelled outcome', async () => {
    const id = 'terminal-outcome-supersedes-interim' as ExecutionId;
    const interim = {
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'Interim result.',
        files: [],
        cost: 0.1,
      },
    };
    await getExecutionStore(id).write('result-meta', interim);
    await getExecutionStore(id).write('meta', {
      timestamp: '2026-07-04T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: RUN_OUTCOME.CANCELLED,
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      ...interim,
      result: { ...interim.result, outcome: RUN_OUTCOME.CANCELLED },
    });
    // Read-time projection only: the turn-owned record is never rewritten, so
    // a later turn's own write still lands on an untouched envelope.
    await expect(getExecutionStore(id).read('result-meta')).resolves.toEqual(
      interim,
    );
  });

  it('keeps a producer failure signal when the execution completed', async () => {
    const id = 'terminal-outcome-keeps-failure' as ExecutionId;
    await getExecutionStore(id).write('result-meta', {
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.FAILED,
        response: 'The subagent reported an error.',
        files: [],
        cost: 0.1,
      },
    });
    await getExecutionStore(id).write('meta', {
      timestamp: '2026-07-04T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.COMPLETED,
      outcome: RUN_OUTCOME.COMPLETED,
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toMatchObject(
      { result: { outcome: RUN_OUTCOME.FAILED } },
    );
  });

  it('keeps the record outcome while the execution has no terminal outcome', async () => {
    const id = 'terminal-outcome-absent' as ExecutionId;
    await getExecutionStore(id).write('result-meta', {
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'Waiting for the next turn.',
        files: [],
        cost: 0.1,
      },
    });
    await getExecutionStore(id).write('meta', {
      timestamp: '2026-07-04T00:00:00.000Z',
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toMatchObject(
      { result: { outcome: RUN_OUTCOME.COMPLETED } },
    );
  });

  // The resume boundary is what keeps the projection honest: a stopped run
  // with a preserved flow record is resumable (`deriveResumability`), and the
  // resumed turns write their own envelopes. Without the boundary clear, the
  // interrupted predecessor's outcome would relabel every one of them.
  it('serves the resumed turn outcome once the resume boundary clears the terminal facts', async () => {
    const id = 'terminal-outcome-resume-boundary' as ExecutionId;
    const interim = {
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'Interim result before the stop.',
        files: [],
        cost: 0.1,
      },
    } satisfies ResultMeta;
    await getExecutionStore(id).write('result-meta', interim);
    await getExecutionStore(id).write('meta', {
      timestamp: '2026-07-04T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await expect(getExecutionStore(id).readResultMeta()).resolves.toMatchObject(
      { result: { outcome: RUN_OUTCOME.CANCELLED } },
    );

    await clearTerminalExecutionState(id);
    await getExecutionStore(id).writeResultMeta({
      ...interim,
      result: {
        ...interim.result,
        response: 'Interim result from the resumed turn.',
      },
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toMatchObject(
      { result: { outcome: RUN_OUTCOME.COMPLETED } },
    );
    await expect(getExecutionStore(id).readMeta()).resolves.toEqual({
      schemaVersion: EXECUTION_META_SCHEMA_VERSION,
      timestamp: '2026-07-04T00:00:00.000Z',
    });
  });

  it('leaves an execution with no persisted metadata untouched at the resume boundary', async () => {
    const id = 'terminal-outcome-resume-no-meta' as ExecutionId;

    await expect(clearTerminalExecutionState(id)).resolves.toBeUndefined();

    await expect(getExecutionStore(id).readMeta()).resolves.toBeNull();
  });

  it('rejects empty result metadata instead of inventing a workflow result', async () => {
    const id = 'bad-result-empty' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('result-meta', {});

    await expect(getExecutionStore(id).readResultMeta()).resolves.toBeNull();
    expectParseWarning(warnSpy, id, 'result-meta.json');
  });

  it('rejects unknown result metadata producers', async () => {
    const id = 'bad-result-producer' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('result-meta', {
      producer: 'unknown',
      outputs: [],
      compileFailures: [],
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toBeNull();
    expectParseWarning(warnSpy, id, 'result-meta.json');
  });

  it('rejects unknown fields in canonical result metadata', async () => {
    const id = 'bad-result-canonical-field' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('result-meta', {
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 12,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'done',
        files: [],
        cost: 0,
      },
      unexpected: true,
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toBeNull();
    expectParseWarning(warnSpy, id, 'result-meta.json');
  });

  it('rejects a CLI workflow record with an explicit tool-use category', async () => {
    const id = 'bad-result-cli-category' as ExecutionId;
    const warnSpy = mockWarn();
    await getExecutionStore(id).write('result-meta', {
      producer: 'cliWorkflow',
      category: 'toolUse',
      outcome: RUN_OUTCOME.COMPLETED,
      result: { response: 'not a workflow result' },
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toBeNull();
    expectParseWarning(warnSpy, id, 'result-meta.json');
  });

  it('reads legacy conversation wrappers as provider messages', async () => {
    const id = 'legacy-conversation-wrapper' as ExecutionId;
    const message = { role: 'user', content: 'Resume this.' };

    await getExecutionStore(id).write('conversation', { messages: [message] });
    await expect(getExecutionStore(id).readConversation()).resolves.toEqual([
      message,
    ]);

    await getExecutionStore(id).write('conversation', {
      conversation: [message],
    });
    await expect(getExecutionStore(id).readConversation()).resolves.toEqual([
      message,
    ]);
  });

  it('warns when conversation storage is malformed instead of silently dropping it', async () => {
    const id = 'bad-conversation-wrapper' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('conversation', { messages: ['text'] });

    await expect(getExecutionStore(id).readConversation()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} conversation.json as provider messages`,
      ),
    );
  });

  it('warns when execution meta is malformed instead of silently dropping it', async () => {
    const id = 'bad-meta' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('meta', { timestamp: 123 });

    await expect(getExecutionStore(id).readMeta()).resolves.toBeNull();
    expectParseWarning(warnSpy, id, 'meta.json');
  });

  it('rejects malformed execution meta for durable repair callers', async () => {
    const id = 'bad-meta-strict' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('meta', { timestamp: 123 });

    await expect(getExecutionStore(id).readMetaStrict()).rejects.toThrow();
    expectParseWarning(warnSpy, id, 'meta.json');
  });

  it('rejects persisted null metadata for durable repair callers', async () => {
    const id = 'null-meta-strict' as ExecutionId;
    mockWarn();

    await getExecutionStore(id).write('meta', null);

    await expect(getExecutionStore(id).readMetaStrict()).rejects.toThrow();
  });
});

describe('ExecutionKVStore loud typed reads', () => {
  it('warns when config is malformed instead of silently returning null', async () => {
    const id = 'bad-config' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('config', { outputFiles: 'not-a-list' });

    await expect(getExecutionStore(id).readConfig()).resolves.toBeNull();
    expectParseWarning(warnSpy, id, 'config.json');
  });

  it('warns when todos are malformed instead of silently defaulting to []', async () => {
    const id = 'bad-todos' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('todos', { not: 'an array' });

    await expect(getExecutionStore(id).readTodos()).resolves.toEqual([]);
    expectParseWarning(warnSpy, id, 'todos.json');
  });

  it('stays quiet for genuinely missing todos (missing != corrupt)', async () => {
    const id = 'no-todos' as ExecutionId;
    const warnSpy = mockWarn();

    await expect(getExecutionStore(id).readTodos()).resolves.toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when workspace files are malformed instead of silently defaulting to []', async () => {
    const id = 'bad-wsfiles' as ExecutionId;
    const warnSpy = mockWarn();

    await getExecutionStore(id).write('workspace-files', [42]);

    await expect(getExecutionStore(id).readWorkspaceFiles()).resolves.toEqual(
      [],
    );
    expectParseWarning(warnSpy, id, 'workspace-files.json');
  });

  it('warns and omits a malformed child record', async () => {
    const id = 'bad-child-record' as ExecutionId;
    const childId = 'valid-child' as ExecutionId;
    const store = getExecutionStore(id);
    const warnSpy = mockWarn();

    await store.writeChild(childId, {
      agent: 'reviewer',
      timestamp: '2026-07-20T00:00:00.000Z',
    });
    await store.write('child-malformed', {
      agent: 42,
      timestamp: '2026-07-20T00:00:00.000Z',
    });

    await expect(store.readChildren()).resolves.toEqual([
      {
        id: childId,
        agent: 'reviewer',
        timestamp: '2026-07-20T00:00:00.000Z',
      },
    ]);
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} child-malformed.json`,
      ),
      { data: expect.any(Error) },
    );
  });
});
