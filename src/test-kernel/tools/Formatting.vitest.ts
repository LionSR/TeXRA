import { describe, expect, it, vi } from 'vitest';

import { formatFileView } from '@tools/formatting';

describe('formatFileView', () => {
  it('slices only the visible prefix when a large range is truncated', () => {
    const lines = Array.from({ length: 3_000 }, (_, index) => `line ${index}`);
    const slice = vi.spyOn(lines, 'slice');

    const result = formatFileView({
      path: 'large.txt',
      lines,
      viewRange: [101, 3_000],
      maxLines: 2_000,
    });

    expect(slice).toHaveBeenCalledOnce();
    expect(slice).toHaveBeenCalledWith(100, 2_100);
    expect(result.summary).toBe('Read lines 101-2100 of large.txt');
    expect(result.output).toContain('...(truncated, 900 more lines)');
  });
});
