// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import {
  createRunContext,
  resolveRunRuntimeHost,
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
    expect(Object.isFrozen(context.approvals)).toBe(true);

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

  it('isolates approval and log objects across contexts', () => {
    const first = createRunContext({ runtimeHost: createRuntimeHost() });
    const second = createRunContext({ runtimeHost: createRuntimeHost() });

    expect(first).not.toBe(second);
    expect(first.logger).not.toBe(second.logger);
    expect(first.approvals).not.toBe(second.approvals);
  });

  it('resolves runtime host from the active run context', () => {
    const runtimeHost = createRuntimeHost();
    const context = createRunContext({ runtimeHost });

    const resolved = withRunContext(context, () => resolveRunRuntimeHost());

    expect(resolved).toBe(runtimeHost);
  });

  it('prefers an explicit runtime host over the active run context', () => {
    const scoped = createRuntimeHost();
    const explicit = createRuntimeHost();
    const context = createRunContext({ runtimeHost: scoped });

    const resolved = withRunContext(context, () =>
      resolveRunRuntimeHost(explicit),
    );

    expect(resolved).toBe(explicit);
  });

  it('requires an active context when no runtime host is explicit', () => {
    expect(() => resolveRunRuntimeHost()).toThrow(/outside withRunContext/);
  });
});
