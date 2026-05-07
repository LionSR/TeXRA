// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import { createRunContext } from '@agent/runtime/RunContext';
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
});
