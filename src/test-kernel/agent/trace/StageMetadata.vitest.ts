import { describe, expect, it } from 'vitest';

import { TraceEmitter, type StageStartEvent } from '@agent/trace';

describe('TraceEmitter stage metadata', () => {
  it('emits typed stage metadata for round stages', () => {
    const trace = new TraceEmitter();
    const starts: StageStartEvent[] = [];
    trace.subscribe((event) => {
      if (event.type === 'stage.start') starts.push(event);
    });

    const stage = trace.openStage('r1', {
      kind: 'round',
      index: 1,
      total: 3,
    });

    expect(starts).toEqual([
      expect.objectContaining({
        id: stage.id,
        label: 'r1',
        kind: 'round',
        index: 1,
        total: 3,
      }),
    ]);
  });
});
