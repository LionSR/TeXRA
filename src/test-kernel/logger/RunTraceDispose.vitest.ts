import { describe, expect, it, vi } from 'vitest';

import { createRunTrace } from '@transcript';

describe('createRunTrace dispose', () => {
  it('releases the transcript residency lease exactly once', () => {
    const close = vi.fn();
    const handle = createRunTrace({ close });

    handle.dispose();
    handle.dispose();

    expect(close).toHaveBeenCalledOnce();
  });
});
