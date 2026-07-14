// Canonical ordering for the vertical session list.

import { type StreamTabId } from '@shared/schemas';

import {
  focusOrderDescendants,
  type ChildStreamEntries,
} from './childExecutions';
import type { StreamSlice } from './cliState';

/**
 * Ordered descendant stream ids for a session list: retained
 * children first (in retained order), then current-topology children not
 * already present. See `childExecutions.ts#focusOrderDescendants` for the
 * full ordering contract — this stays a thin wrapper so callers keep a
 * stable `{ parent, childStreamEntries, streams }` shape.
 */
export function orderedDescendantsFromTree(init: {
  readonly parent: StreamTabId;
  readonly childStreamEntries: ChildStreamEntries;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StreamTabId[] {
  return [
    ...focusOrderDescendants(
      init.parent,
      init.childStreamEntries,
      init.streams,
    ),
  ];
}
