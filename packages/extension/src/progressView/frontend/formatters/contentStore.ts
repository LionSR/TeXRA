/**
 * Generic content-addressable registry for progress view formatters.
 *
 * Stores a value by ID so it can be retrieved later without duplicating large
 * or typed payloads in DOM attributes. IDs are content-hash-derived by
 * default (re-rendering the same value yields the same ID, so repeated
 * renders don't leak memory), or caller-supplied when the value is expected
 * to change under a stable identity (e.g. a streaming message).
 */

import { LRUCache } from 'lru-cache';

import { hashString } from './hashUtils';

export interface ContentStore<T extends NonNullable<unknown>> {
  register(value: T, explicitId?: string): string;
  get(id: string): T | undefined;
  clear(): void;
}

export function createContentStore<T extends NonNullable<unknown>>(options: {
  max: number;
  prefix: string;
  serialize: (value: T) => string;
}): ContentStore<T> {
  const store = new LRUCache<string, T>({ max: options.max });

  return {
    register(value, explicitId) {
      let id = explicitId;
      if (id === undefined) {
        const serialized = options.serialize(value);
        id = `${options.prefix}:${serialized.length}:${hashString(serialized)}`;
      }
      if (store.get(id) !== value) {
        store.set(id, value);
      }
      return id;
    },
    get: (id) => store.get(id),
    clear: () => store.clear(),
  };
}
