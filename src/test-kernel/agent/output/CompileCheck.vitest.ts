// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { formatCompileLogTail } from '@agent/output/compileCheck';

describe('formatCompileLogTail', () => {
  it('uses the last 200 content lines without counting a trailing newline', () => {
    const log = Array.from(
      { length: 201 },
      (_, index) => `line-${String(index + 1).padStart(3, '0')}`,
    ).join('\r\n');

    const tail = formatCompileLogTail(`${log}\r\n`);

    expect(tail.split('\n')).toHaveLength(200);
    expect(tail.startsWith('line-002\n')).toBe(true);
    expect(tail.endsWith('line-201')).toBe(true);
    expect(tail).not.toContain('\r');
  });
});
