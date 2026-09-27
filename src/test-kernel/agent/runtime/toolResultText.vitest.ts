// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - utils
import { formatToolResultAsText } from '@agent/runtime/run/toolResultText';

/** The formatter's cap: a result longer than this is truncated head+tail. */
const TOOL_RESULT_TEXT_CAP = 200_000;

/** Head and tail well over their truncation budgets, with an elidable middle. */
function oversizedText(): { head: string; tail: string; text: string } {
  const head = 'HEAD_MARKER_'.repeat(500);
  const tail = 'TAIL_MARKER_'.repeat(5000);
  return {
    head,
    tail,
    text: head + 'x'.repeat(TOOL_RESULT_TEXT_CAP) + tail,
  };
}

describe('formatToolResultAsText', () => {
  it('keeps head and tail when result exceeds limit, not a discard stub', () => {
    const { text } = oversizedText();
    const result = formatToolResultAsText({
      status: 'executed',
      output: text,
    });
    expect(result).toContain('Tool result too large');
    expect(result).toContain('characters elided');
    expect(result).not.toContain('was not included');
    expect(result).toContain('HEAD_MARKER_');
    expect(result).toContain('TAIL_MARKER_');
    expect(result).not.toContain('x'.repeat(1000));
    expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_CAP);
  });
});
