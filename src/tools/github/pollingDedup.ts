/** Deduplication and cursor tracking shared by GitHub polling sources. */

import {
  createBoundedIdSet,
  type BoundedIdSet,
} from '@utils/core/boundedIdSet';
import { getNewestTimestamp } from './githubPaths';

interface DedupedResourceOptions<T, Id> {
  getId(item: T): Id;
  getCursor?(items: readonly T[]): string | undefined;
  maxSeenIds: number;
  sinceCursor?: string;
}

export class DedupedResource<T, Id extends NonNullable<unknown> = number> {
  readonly seenIds: BoundedIdSet<Id>;
  sinceCursor: string | undefined;

  private readonly getId: (item: T) => Id;
  private readonly getCursor:
    ((items: readonly T[]) => string | undefined) | undefined;

  constructor(options: DedupedResourceOptions<T, Id>) {
    this.getId = options.getId;
    this.getCursor = options.getCursor;
    this.sinceCursor = options.sinceCursor;
    this.seenIds = createBoundedIdSet<Id>(options.maxSeenIds);
  }

  seed(items: readonly T[]): void {
    for (const item of items) {
      this.seenIds.add(this.getId(item));
    }
    this.advanceCursor(items);
  }

  diff(items: readonly T[], emit: (item: T) => void): void {
    // Classify the whole batch against pre-batch membership before adding
    // anything, so an eviction triggered partway through this tick can't
    // make an id already seen this tick look "new" again (`newIds` also
    // catches the same id appearing twice within one fetched page).
    const newIds = new Set<Id>();
    for (const item of items) {
      const id = this.getId(item);
      if (this.seenIds.has(id) || newIds.has(id)) continue;
      newIds.add(id);
      emit(item);
    }
    for (const id of newIds) this.seenIds.add(id);
    this.advanceCursor(items);
  }

  private advanceCursor(items: readonly T[]): void {
    const newest = this.getCursor?.(items);
    if (newest) this.sinceCursor = newest;
  }
}

/**
 * Per-resource id history is trimmed to this many entries so long-running
 * subscriptions don't grow the dedup set unboundedly. Shared by every
 * comment-shaped poller (issue comments, PR review comments, repo-wide
 * issue/review comments).
 */
export const MAX_SEEN_IDS = 1000;

interface CommentShape {
  id: number;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Build a {@link DedupedResource} for comment-shaped items, hardcoding the
 * three options every comment poller agrees on: id-keyed dedup, newest-
 * timestamp cursor advance (via {@link getNewestTimestamp}), and the shared
 * {@link MAX_SEEN_IDS} window. Callers pass only an optional seed cursor.
 */
export function dedupeComments<T extends CommentShape>(options?: {
  sinceCursor?: string;
}): DedupedResource<T> {
  return new DedupedResource<T>({
    getId: (item) => item.id,
    getCursor: getNewestTimestamp,
    maxSeenIds: MAX_SEEN_IDS,
    sinceCursor: options?.sinceCursor,
  });
}
