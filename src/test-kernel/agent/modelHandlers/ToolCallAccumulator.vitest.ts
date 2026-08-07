import { describe, expect, it } from 'vitest';

import { ToolCallAccumulator } from '@agent/modelHandlers/utils/toolCallAccumulator';

type Built = { id: string; name: string; arguments: string };

function build(acc: ToolCallAccumulator): Built[] {
  return acc.build(({ id, name, arguments: args }) => ({
    id,
    name,
    arguments: args,
  }));
}

describe('ToolCallAccumulator', () => {
  it('assembles id, name, and argument fragments spread across deltas', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'call_1', name: 'get_', arguments: '{"a"' });
    acc.add({ index: 0, name: 'weather', arguments: ':1}' });

    expect(build(acc)).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: '{"a":1}' },
    ]);
  });

  it('keeps the first non-empty id and never concatenates re-sent ids', () => {
    const acc = new ToolCallAccumulator();
    // A provider re-sending the same id across chunks must not corrupt it.
    acc.add({ index: 0, id: 'call_1', name: 'fn' });
    acc.add({ index: 0, id: 'call_1', arguments: '{}' });

    expect(build(acc)).toEqual([{ id: 'call_1', name: 'fn', arguments: '{}' }]);
  });

  it('can emit raw entries without dropping empties or adding fallback ids', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: '', name: '', arguments: '' });
    acc.add({ index: 1, name: 'noId', arguments: '{}' });

    const raw = acc.build(
      ({ id, name, arguments: args }) => ({ id, name, arguments: args }),
      { dropEmpty: false, fallbackId: false },
    );
    expect(raw).toEqual([
      { id: '', name: '', arguments: '' },
      { id: '', name: 'noId', arguments: '{}' },
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
});
