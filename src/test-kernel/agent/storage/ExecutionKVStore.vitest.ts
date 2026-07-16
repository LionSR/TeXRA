import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  clearStoreCache,
  EXECUTION_META_SCHEMA_VERSION,
  getExecutionStore,
  isReservedKvKeyName,
} from '@agent/storage';
import * as logger from '@logger/logUtils';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
} from '@shared/schemas';

setupPlatform({ workspacePath: '/workspace' });

beforeEach(() => {
  clearStoreCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Regression for the executionKvFiles leak fix: isReservedKvKeyName is now
// the single owner of the reserved single-value-key + `child-` prefix
// vocabulary, exported so callers walking a run directory (e.g.
// `src/tools/executions/executionKvFiles.ts`) recognize it without
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

  it('normalizes legacy flat CLI workflow result metadata', async () => {
    const id = 'legacy-result-workflow' as ExecutionId;
    const output = {
      round: 1,
      relativePath: 'r1/output.tex',
      absolutePath: '/workspace/.texra/runs/r1/output.tex',
      location: 'runStorage' as const,
      originalPath: '/workspace/output.tex',
      added: 2,
      removed: 1,
    };
    await getExecutionStore(id).write('result-meta', {
      copiedOutput: '/workspace/output.tex',
      outputs: [output],
      compileFailures: [],
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'cliWorkflow',
      copiedOutput: '/workspace/output.tex',
      result: {
        category: 'workflow',
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [output],
        compileFailures: [],
        diffs: [],
        cost: 0,
      },
    });
  });

  it('normalizes legacy flat subagent result metadata', async () => {
    const id = 'legacy-result-subagent' as ExecutionId;
    await getExecutionStore(id).write('result-meta', {
      agentName: 'reviewer',
      category: 'toolUse',
      outcome: RUN_OUTCOME.COMPLETED,
      success: true,
      wallTimeMs: 25,
      lastResponse: 'done',
      touchedFiles: ['notes.md'],
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 25,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'done',
        files: ['notes.md'],
        cost: 0,
      },
    });
  });

  it('normalizes the currently tagged subagent shape without rewriting it', async () => {
    const id = 'tagged-result-subagent' as ExecutionId;
    const persisted = {
      producer: 'subagent',
      agentName: 'reviewer',
      outcome: RUN_OUTCOME.CANCELLED,
      success: false,
      wallTimeMs: 25,
      totalCostUsd: 0.3,
      result: {
        category: 'toolUse',
        lastResponse: 'Stopped at the requested boundary.',
        touchedFiles: ['notes.md'],
      },
    };
    await getExecutionStore(id).write('meta', {
      timestamp: '2026-07-04T00:00:00.000Z',
      outcome: RUN_OUTCOME.FAILED,
    });
    await getExecutionStore(id).write('config', {
      agent: 'writer',
      model: 'gpt5',
      agentCategory: 'workflow',
    });
    await getExecutionStore(id).write('result-meta', persisted);

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 25,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.CANCELLED,
        response: 'Stopped at the requested boundary.',
        files: ['notes.md'],
        cost: 0.3,
      },
    });
    await expect(getExecutionStore(id).read('result-meta')).resolves.toEqual(
      persisted,
    );
  });

  it('normalizes the currently tagged subagent workflow shape', async () => {
    const id = 'tagged-result-subagent-workflow' as ExecutionId;
    await getExecutionStore(id).write('result-meta', {
      producer: 'subagent',
      agentName: 'polish',
      outcome: RUN_OUTCOME.FAILED,
      success: false,
      wallTimeMs: 40,
      totalCostUsd: 0.6,
      result: {
        category: 'workflow',
        outputs: [],
        compileFailures: [],
        diffs: [],
      },
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'subagent',
      agentName: 'polish',
      wallTimeMs: 40,
      result: {
        category: 'workflow',
        outcome: RUN_OUTCOME.FAILED,
        outputs: [],
        compileFailures: [],
        diffs: [],
        cost: 0.6,
      },
    });
  });

  it('normalizes the currently tagged CLI workflow shape', async () => {
    const id = 'tagged-result-cli-workflow' as ExecutionId;
    await getExecutionStore(id).write('meta', {
      timestamp: '2026-07-04T00:00:00.000Z',
      outcome: RUN_OUTCOME.FAILED,
    });
    await getExecutionStore(id).write('result-meta', {
      producer: 'cliWorkflow',
      result: {
        copiedOutputs: ['/workspace/out/paper.tex'],
        outputs: [],
        compileFailures: [],
      },
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'cliWorkflow',
      copiedOutputs: ['/workspace/out/paper.tex'],
      result: {
        category: 'workflow',
        outcome: RUN_OUTCOME.FAILED,
        outputs: [],
        compileFailures: [],
        diffs: [],
        cost: 0,
      },
    });
  });

  it('infers category for legacy subagent result metadata with no category tag (workflow fields)', async () => {
    const id = 'legacy-result-subagent-no-category' as ExecutionId;
    const output = {
      round: 1,
      relativePath: 'r1/output.tex',
      absolutePath: '/workspace/.texra/runs/r1/output.tex',
      location: 'runStorage' as const,
      originalPath: '/workspace/output.tex',
      added: 2,
      removed: 1,
    };
    await getExecutionStore(id).write('result-meta', {
      agentName: 'writer',
      outcome: RUN_OUTCOME.COMPLETED,
      success: true,
      wallTimeMs: 40,
      outputs: [output],
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'subagent',
      agentName: 'writer',
      wallTimeMs: 40,
      result: {
        category: 'workflow',
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [output],
        compileFailures: [],
        diffs: [],
        cost: 0,
      },
    });
  });

  it('infers category for legacy subagent result metadata with no category tag (toolUse fields)', async () => {
    const id = 'legacy-result-subagent-no-category-tooluse' as ExecutionId;
    await getExecutionStore(id).write('result-meta', {
      agentName: 'reviewer',
      outcome: RUN_OUTCOME.COMPLETED,
      success: true,
      wallTimeMs: 25,
      lastResponse: 'done',
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 25,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'done',
        files: [],
        cost: 0,
      },
    });
  });

  it('uses execution metadata and config only after stored fields cannot decide', async () => {
    const id = 'legacy-result-context-fallback' as ExecutionId;
    await getExecutionStore(id).write('meta', {
      timestamp: '2026-07-04T00:00:00.000Z',
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await getExecutionStore(id).write('config', {
      agent: 'reviewer',
      model: 'gpt5',
      agentCategory: 'toolUse',
    });
    await getExecutionStore(id).write('result-meta', {
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 12,
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 12,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.CANCELLED,
        response: '',
        files: [],
        cost: 0,
      },
    });
  });

  it('rejects a minimal legacy subagent result without category or outcome context', async () => {
    const id = 'legacy-result-insufficient-context' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await getExecutionStore(id).write('result-meta', {
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 12,
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} result-meta.json`,
      ),
      { data: expect.any(Error) },
    );
  });

  it('normalizes legacy flat background bash result metadata', async () => {
    const id = 'legacy-result-bash' as ExecutionId;
    await getExecutionStore(id).write('result-meta', {
      command: 'echo hi',
      exitCode: 0,
      wallTimeMs: 10,
      success: true,
      timedOut: false,
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toEqual({
      producer: 'backgroundBash',
      command: 'echo hi',
      exitCode: 0,
      wallTimeMs: 10,
      success: true,
      timedOut: false,
    });
  });

  it('rejects empty result metadata instead of inventing a workflow result', async () => {
    const id = 'bad-result-empty' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('result-meta', {});

    await expect(getExecutionStore(id).readResultMeta()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} result-meta.json`,
      ),
      { data: expect.any(Error) },
    );
  });

  it('rejects unknown result metadata producers', async () => {
    const id = 'bad-result-producer' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('result-meta', {
      producer: 'unknown',
      outputs: [],
      compileFailures: [],
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} result-meta.json`,
      ),
      { data: expect.any(Error) },
    );
  });

  it('does not erase unknown fields by reclassifying a canonical record as legacy', async () => {
    const id = 'bad-result-canonical-field' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

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
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} result-meta.json`,
      ),
      { data: expect.any(Error) },
    );
  });

  it('rejects a CLI workflow record with an explicit tool-use category', async () => {
    const id = 'bad-result-cli-category' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await getExecutionStore(id).write('result-meta', {
      producer: 'cliWorkflow',
      category: 'toolUse',
      outcome: RUN_OUTCOME.COMPLETED,
      result: { response: 'not a workflow result' },
    });

    await expect(getExecutionStore(id).readResultMeta()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} result-meta.json`,
      ),
      { data: expect.any(Error) },
    );
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
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

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
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('meta', { timestamp: 123 });

    await expect(getExecutionStore(id).readMeta()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(`Failed to parse execution ${id} meta.json`),
      { data: expect.any(Error) },
    );
  });
});

describe('ExecutionKVStore loud typed reads (#6966 bullet 5)', () => {
  it('warns when config is malformed instead of silently returning null', async () => {
    const id = 'bad-config' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('config', { outputFiles: 'not-a-list' });

    await expect(getExecutionStore(id).readConfig()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(`Failed to parse execution ${id} config.json`),
      { data: expect.any(Error) },
    );
  });

  it('warns when todos are malformed instead of silently defaulting to []', async () => {
    const id = 'bad-todos' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('todos', { not: 'an array' });

    await expect(getExecutionStore(id).readTodos()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(`Failed to parse execution ${id} todos.json`),
      { data: expect.any(Error) },
    );
  });

  it('stays quiet for genuinely missing todos (missing != corrupt)', async () => {
    const id = 'no-todos' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(getExecutionStore(id).readTodos()).resolves.toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when workspace files are malformed instead of silently defaulting to []', async () => {
    const id = 'bad-wsfiles' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('workspace-files', [42]);

    await expect(getExecutionStore(id).readWorkspaceFiles()).resolves.toEqual(
      [],
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} workspace-files.json`,
      ),
      { data: expect.any(Error) },
    );
  });
});
