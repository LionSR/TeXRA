/**
 * Generic content-addressable registry for progress view formatters, plus the
 * two concrete registries built on it (copy content and proposal inputs).
 *
 * Stores a value by ID so it can be retrieved later without duplicating large
 * or typed payloads in DOM attributes. IDs are content-hash-derived by
 * default (re-rendering the same value yields the same ID, so repeated
 * renders don't leak memory), or caller-supplied when the value is expected
 * to change under a stable identity (e.g. a streaming message).
 */

import { LRUCache } from 'lru-cache';

import { parseDelegationToolInput, type AgentProposal } from '@shared/schemas';

/** Simple string hash for generating stable content-based IDs. */
function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

interface ContentStore<T extends NonNullable<unknown>> {
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
      // Reference equality is sufficient: for object values re-derived from a
      // hash-based id (e.g. AgentProposal), each re-parse is a new object, so
      // this always re-sets and refreshes the LRU position — harmless, since
      // the content is unchanged. It only skips the write when the exact same
      // object instance is re-registered under its own explicit id.
      if (store.get(id) !== value) {
        store.set(id, value);
      }
      return id;
    },
    get: (id) => store.get(id),
    clear: () => store.clear(),
  };
}

// Copy content registry: stores copyable content by ID to avoid duplicating
// large strings in DOM attributes.
const copyContentStore = createContentStore<string>({
  max: 1000,
  prefix: 'auto',
  serialize: (content) => content,
});

/**
 * Register copy content and return a stable ID for lookup.
 */
export function registerCopyContent(
  content: string,
  contentId?: string,
): string {
  return copyContentStore.register(content, contentId);
}

/**
 * Retrieve copy content by ID.
 */
export function getCopyContent(id: string): string | undefined {
  return copyContentStore.get(id);
}

/**
 * Clear all copy content entries (called on stream delete / delete-all).
 */
export function clearCopyContentStore(): void {
  copyContentStore.clear();
}

// Proposal input registry: stores typed proposal payloads by ID so they can be
// retrieved when the user clicks the "Setup" link on a completed proposal log
// entry. Parsing the raw tool input into a typed proposal is domain logic and
// lives in the schema layer (`parseDelegationToolInput`).
const proposalInputStore = createContentStore<AgentProposal>({
  max: 500,
  prefix: 'proposal',
  serialize: (proposal) => JSON.stringify(proposal),
});

/**
 * Register proposal input and return a stable ID for lookup.
 */
export function registerProposalInput(
  input: unknown,
  toolName: string,
): string | null {
  const proposal = parseDelegationToolInput(input, toolName);
  if (!proposal) return null;
  return proposalInputStore.register(proposal);
}

/**
 * Retrieve proposal input by ID.
 */
export function getProposalInput(id: string): AgentProposal | undefined {
  return proposalInputStore.get(id);
}

/**
 * Clear all proposal input entries (called on stream delete / delete-all).
 */
export function clearProposalInputStore(): void {
  proposalInputStore.clear();
}
