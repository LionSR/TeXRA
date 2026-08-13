// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { spiedTrace } from '@test/support/spiedTrace';

describe('spiedTrace', () => {
  it('rejects access to trace members omitted from a strict test double', () => {
    const warn = vi.fn();
    const trace = spiedTrace({ warn }, { strict: true });

    trace.warn('expected warning');

    expect(warn).toHaveBeenCalledWith('expected warning');
    expect(() => trace.error('unexpected error')).toThrow(
      'Unexpected AgentTrace.error access',
    );
  });
});
