import { vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import { noopTrace } from '@agent/trace';

/**
 * `noopTrace` with `debug`/`info`/`warn`/`error`/`domain` replaced by
 * `vi.fn()` spies, for tests that assert on trace calls. Pass `overrides`
 * to spy on additional members or stub others.
 */
export function spiedTrace(overrides?: Partial<AgentTrace>): AgentTrace {
  return {
    ...noopTrace,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    domain: vi.fn(),
    ...overrides,
  };
}
