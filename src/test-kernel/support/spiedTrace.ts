import { vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import { noopTrace } from '@agent/trace';

interface SpiedTraceOptions {
  /** Throw when code reads a trace member not supplied in `overrides`. */
  readonly strict?: boolean;
}

/**
 * `noopTrace` with `debug`/`info`/`warn`/`error`/`domain` replaced by
 * `vi.fn()` spies, for tests that assert on trace calls. Pass `overrides`
 * to spy on additional members or stub others. Strict mode preserves the
 * narrower contract of a minimal test double: only explicitly supplied
 * members may be read.
 */
export function spiedTrace(
  overrides?: Partial<AgentTrace>,
  options?: SpiedTraceOptions,
): AgentTrace {
  const trace: AgentTrace = {
    ...noopTrace,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    domain: vi.fn(),
    ...overrides,
  };

  if (!options?.strict) {
    return trace;
  }

  const permittedMembers = new Set(Reflect.ownKeys(overrides ?? {}));
  return new Proxy(trace, {
    get(target, property, receiver) {
      if (typeof property === 'symbol' || permittedMembers.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(
        `Unexpected AgentTrace.${String(property)} access; add it to the strict test double`,
      );
    },
  });
}
