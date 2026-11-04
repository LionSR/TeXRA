// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - utils
import { formatToolResultAsText } from '@agent/runtime/run/toolResultText';

/** The formatter's cap: a result longer than this is truncated head+tail. */
const TOOL_RESULT_TEXT_CAP = 200_000;

describe('formatToolResultAsText', () => {
  it('keeps head and tail when result exceeds limit, not a discard stub', () => {
    const result = formatToolResultAsText({
      status: 'executed',
      output:
        'HEAD_MARKER_'.repeat(500) +
        'x'.repeat(TOOL_RESULT_TEXT_CAP) +
        'TAIL_MARKER_'.repeat(5000),
    });
    expect(result).toContain('HEAD_MARKER_');
    expect(result).toContain('TAIL_MARKER_');
    expect(result).not.toContain('x'.repeat(1000));
    expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_CAP);
  });
});
