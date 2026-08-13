import { describe, expect, it } from 'vitest';

import {
  activeStreamParentOrSelfId,
  activeStreamScope,
  nearestActiveStreamAncestor,
} from '@cli/chat/tui/state/streamViews';
import type { StreamTabId } from '@shared/schemas';

function streamId(value: string): StreamTabId {
  return value as StreamTabId;
}

describe('active stream scope', () => {
  it('projects root and child ownership', () => {
    const root = streamId('root');
    const child = streamId('child');
    const parentStream = new Map<StreamTabId, StreamTabId>([[child, root]]);

    expect(
      activeStreamScope({ activeStreamId: undefined, parentStream }),
    ).toEqual({ kind: 'none' });
    expect(activeStreamScope({ activeStreamId: root, parentStream })).toEqual({
      kind: 'root',
      streamId: root,
    });
    expect(activeStreamScope({ activeStreamId: child, parentStream })).toEqual({
      kind: 'child',
      parentStreamId: root,
      streamId: child,
    });
    expect(
      activeStreamParentOrSelfId({ activeStreamId: child, parentStream }),
    ).toBe(root);
  });

  it('finds the nearest usable ancestor', () => {
    const root = streamId('root');
    const child = streamId('child');
    const grandchild = streamId('grandchild');
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [child, root],
      [grandchild, child],
    ]);
    const values = new Map([
      [root, { usable: true }],
      [child, { usable: false }],
    ]);

    expect(
      nearestActiveStreamAncestor({
        activeStreamId: grandchild,
        parentStream,
        values,
        canUseValue: (value) => value.usable,
      }),
    ).toEqual({ streamId: root, value: { usable: true } });
  });

  it('stops ancestor traversal at parent cycles', () => {
    const first = streamId('first');
    const second = streamId('second');
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [first, second],
      [second, first],
    ]);

    expect(
      nearestActiveStreamAncestor({
        activeStreamId: first,
        parentStream,
        values: new Map([[first, { usable: true }]]),
        canUseValue: (value) => value.usable,
      }),
    ).toBeUndefined();
  });
});
