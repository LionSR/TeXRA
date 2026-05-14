// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import {
  createRunContext,
  useRunContext,
  withRunContext,
} from '@agent/runtime/RunContext';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';

function createRuntimeHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('RunContext', () => {
  it('freezes the context and per-run containers', () => {
    const context = createRunContext({ runtimeHost: createRuntimeHost() });

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.logger)).toBe(true);

    expect(() => {
      (context as { logger: unknown }).logger = {};
    }).toThrow(TypeError);
  });

  it('requires an explicit runtime host', () => {
    expect(() =>
      createRunContext({
        runtimeHost: undefined as unknown as AgentRuntimeHost,
      }),
    ).toThrow(/explicit runtimeHost/);
  });

  it('isolates log objects across contexts', () => {
    const first = createRunContext({ runtimeHost: createRuntimeHost() });
    const second = createRunContext({ runtimeHost: createRuntimeHost() });

    expect(first).not.toBe(second);
    expect(first.logger).not.toBe(second.logger);
  });

  it('exposes the runtime host owned by the active context', () => {
    const runtimeHost = createRuntimeHost();
    const context = createRunContext({ runtimeHost });

    const resolved = withRunContext(context, () => useRunContext().runtimeHost);

    expect(resolved).toBe(runtimeHost);
  });

  it('requires an active context for owned runtime state', () => {
    expect(() => useRunContext()).toThrow(/outside withRunContext/);
  });
});
