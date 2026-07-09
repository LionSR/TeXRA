// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import {
  createRunContext,
  useRunContext,
  withRunContext,
} from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

function createRuntimeHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('RunContext', () => {
  it('freezes the context and per-run containers', () => {
    const context = createRunContext({ runtimeHost: createRuntimeHost() });

    expect(Object.isFrozen(context)).toBe(true);

    expect(() => {
      (context as { runtimeHost: unknown }).runtimeHost = {};
    }).toThrow(TypeError);
  });

  it('requires an explicit runtime host', () => {
    expect(() =>
      createRunContext({
        runtimeHost: undefined as unknown as AgentRuntimeHost,
      }),
    ).toThrow(/explicit runtimeHost/);
  });

  it('exposes the runtime host owned by the active context', () => {
    const runtimeHost = createRuntimeHost();
    const context = createRunContext({ runtimeHost });

    const resolved = withRunContext(context, () => useRunContext().runtimeHost);

    expect(resolved).toBe(runtimeHost);
  });

  it('reads the current model from a live provider', () => {
    let currentModel: string | undefined = 'deepseekT';
    const context = createRunContext({
      runtimeHost: createRuntimeHost(),
      streamId: 'live-model-stream' as StreamTabId,
      executionId: 'live-model-execution' as ExecutionId,
      modelSource: 'live',
      model: 'fallback-model',
      getModel: () => currentModel,
      agentName: 'test-agent',
      session: {} as SessionHandle,
    });

    expect(Object.getOwnPropertyDescriptor(context, 'model')?.get).toBeTypeOf(
      'function',
    );
    expect(context.model).toBe('deepseekT');

    currentModel = 'sonnet46T';

    const resolved = withRunContext(context, () => useRunContext().model);

    expect(resolved).toBe('sonnet46T');

    currentModel = undefined;

    expect(context.model).toBe('fallback-model');
  });

  it('preserves the exact run scope on launch contexts', () => {
    const runtimeHost = createRuntimeHost();
    const runScope = createRunScope({
      runtimeHost,
      streamId: 'scoped-stream' as StreamTabId,
      executionId: 'scoped-execution' as ExecutionId,
      agentName: 'scoped-agent',
      workingDirectory: '/tmp/scoped-worktree',
      session: {} as SessionHandle,
    });
    const context = createRunContext({
      runtimeHost,
      runScope,
      streamId: runScope.streamId,
      executionId: runScope.executionId,
      modelSource: 'live',
      getModel: () => 'deepseekT',
      agentName: runScope.agentName,
      session: runScope.session,
    });

    expect(Object.isFrozen(runScope)).toBe(true);
    expect(context.kind).toBe('launch');
    if (context.kind !== 'launch') {
      throw new Error('expected launch context');
    }
    expect(context.runScope).toBe(runScope);
    expect(context.runtimeHost).toBe(runScope.runtimeHost);
    expect(context.streamId).toBe(runScope.streamId);
    expect(context.executionId).toBe(runScope.executionId);
    expect(context.agentName).toBe(runScope.agentName);
    expect(context.workingDirectory).toBe(runScope.workingDirectory);
    expect(context.session).toBe(runScope.session);
  });

  it('requires an active context for owned runtime state', () => {
    expect(() => useRunContext()).toThrow(/outside withRunContext/);
  });
});
