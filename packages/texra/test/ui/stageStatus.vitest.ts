import { describe, expect, it } from 'vitest';

import { stageStatus } from '@ui/copy/runStatus';

describe('stageStatus', () => {
  // A run whose process died mid-turn has no `run.end`, so nothing closed
  // the stage it had open: its header reads as the run reads, not running.
  it('reads an open stage of an interrupted run as interrupted', () => {
    const status = stageStatus(
      { outcome: null },
      { holder: 'none', outcome: null },
    );
    expect(status.key).toBe('interrupted');
    expect(status.word).toBe('Interrupted');
  });
});
