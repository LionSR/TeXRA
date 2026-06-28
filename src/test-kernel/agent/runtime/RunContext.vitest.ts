// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import {
  createRunContext,
  useRunContext,
  withRunContext,
} from '@agent/runtime/RunContext';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';

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
      model: 'fallback-model',
      getModel: () => currentModel,
    });

    expect(context.model).toBe('deepseekT');

    currentModel = 'sonnet46T';

    const resolved = withRunContext(context, () => useRunContext().model);

    expect(resolved).toBe('sonnet46T');

    currentModel = undefined;

    expect(context.model).toBe('fallback-model');
  });

  it('requires an active context for owned runtime state', () => {
    expect(() => useRunContext()).toThrow(/outside withRunContext/);
  });
});
