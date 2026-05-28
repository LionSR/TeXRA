import { describe, expect, it } from 'vitest';

import { ToolCallAccumulator } from '@agent/modelHandlers/utils/toolCallAccumulator';

type Built = { id: string; name: string; arguments: string };

const build = (acc: ToolCallAccumulator): Built[] =>
  acc.build(({ id, name, arguments: args }) => ({
    id,
    name,
    arguments: args,
  }));

describe('ToolCallAccumulator', () => {
  it('assembles id, name, and argument fragments spread across deltas', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'call_1', name: 'get_', arguments: '{"a"' });
    acc.add({ index: 0, name: 'weather', arguments: ':1}' });

    expect(build(acc)).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: '{"a":1}' },
    ]);
  });

  it('materializes multiple calls in ascending index order', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 1, id: 'b', name: 'second', arguments: '{}' });
    acc.add({ index: 0, id: 'a', name: 'first', arguments: '{}' });

    expect(build(acc).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('drops fully-empty entries', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: '', name: '', arguments: '' });
    acc.add({ index: 1, id: null, name: undefined, arguments: null });

    expect(build(acc)).toEqual([]);
  });

  it('substitutes a stable fallback id when none streamed', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 2, name: 'noId', arguments: '{}' });

    expect(build(acc)).toEqual([
      { id: 'tool_call_2', name: 'noId', arguments: '{}' },
    ]);
  });

  it('reports the number of tracked indices via size', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'a' });
    acc.add({ index: 0, name: 'x' });
    acc.add({ index: 5, id: 'b' });

    expect(acc.size).toBe(2);
  });
});
