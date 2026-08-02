// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import {
  createRunContext,
  getRunContextAgentName,
  getRunContextExecutionId,
  getRunContextSession,
  getRunContextStreamId,
  getRunContextWorkingDirectory,
  useRunContext,
  withRunContext,
} from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import { testModelCell } from '../modelCellTestUtils';

describe('RunContext', () => {
  it('reads the current model through the run model cell', () => {
    const runScope = createRunScope({
      streamId: 'live-model-stream' as StreamTabId,
      executionId: 'live-model-execution' as ExecutionId,
      agentName: 'test-agent',
      session: {} as SessionHandle,
      signal: new AbortController().signal,
    });
    const modelCell = testModelCell({ dispose: vi.fn() }, 'deepseekT');
    const context = createRunContext({ runScope, modelCell });

    expect(Object.getOwnPropertyDescriptor(context, 'model')?.get).toBeTypeOf(
      'function',
    );
    expect(context.model).toBe('deepseekT');

    modelCell.swap({ dispose: vi.fn() } as never, 'sonnet46T');

    const resolved = withRunContext(context, () => useRunContext().model);

    expect(resolved).toBe('sonnet46T');
  });

  it('reads a bare context model from its one-shot cell', () => {
    const context = createRunContext({
      streamId: 'bare-model-stream' as StreamTabId,
      modelCell: Object.freeze({ modelId: 'gpt54' }),
    });

    expect(context.kind).toBe('bare');
    expect(context.model).toBe('gpt54');
  });

  it('preserves the exact run scope on launch contexts', () => {
    const runScope = createRunScope({
      streamId: 'scoped-stream' as StreamTabId,
      executionId: 'scoped-execution' as ExecutionId,
      agentName: 'scoped-agent',
      workingDirectory: '/tmp/scoped-worktree',
      session: {} as SessionHandle,
      signal: new AbortController().signal,
    });
    const context = createRunContext({
      runScope,
      modelCell: Object.freeze({ modelId: 'deepseekT' }),
    });

    expect(Object.isFrozen(runScope)).toBe(true);
    expect(context.kind).toBe('launch');
    if (context.kind !== 'launch') {
      throw new Error('expected launch context');
    }
    expect(context.runScope).toBe(runScope);
    expect('streamId' in context).toBe(false);
    expect('executionId' in context).toBe(false);
    expect('agentName' in context).toBe(false);
    expect('workingDirectory' in context).toBe(false);
    expect('session' in context).toBe(false);
    expect(getRunContextStreamId(context)).toBe(runScope.streamId);
    expect(getRunContextExecutionId(context)).toBe(runScope.executionId);
    expect(getRunContextAgentName(context)).toBe(runScope.agentName);
    expect(getRunContextWorkingDirectory(context)).toBe(
      runScope.workingDirectory,
    );
    expect(getRunContextSession(context)).toBe(runScope.session);
  });

  it('requires an active context for owned runtime state', () => {
    expect(() => useRunContext()).toThrow(/outside withRunContext/);
  });
});
