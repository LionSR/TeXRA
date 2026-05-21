import { describe, expect, it } from 'vitest';

import { isCliPipeClosureError } from '../../../packages/cli/src/runtime/logSinks';

describe('CLI log sinks', () => {
  it('recognizes pipe closure errors as non-fatal output events', () => {
    expect(
      isCliPipeClosureError(
        Object.assign(new Error('write EPIPE'), {
          code: 'EPIPE',
        }),
      ),
    ).toBe(true);
    expect(
      isCliPipeClosureError(
        Object.assign(new Error('stream destroyed'), {
          code: 'ERR_STREAM_DESTROYED',
        }),
      ),
    ).toBe(true);
    expect(isCliPipeClosureError(new Error('disk full'))).toBe(false);
  });
});
