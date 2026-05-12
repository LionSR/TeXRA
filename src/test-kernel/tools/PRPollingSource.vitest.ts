// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - tools
import { GitHubRateLimitError } from '@tools/github/githubClient';
import { PRPollingSource } from '@tools/github/PRPollingSource';
import type { GhCheckRun } from '@tools/github/prTypes';

interface AnnotationDrainState {
  pr: { owner: string; repo: string; pullNumber: number };
  slug: string;
  listeners: Set<(text: string) => void>;
  pendingAnnotationRuns: GhCheckRun[];
}

interface AnnotationDrainSource {
  drainAnnotationQueue(state: AnnotationDrainState): Promise<void>;
  fetchAnnotations(
    owner: string,
    repo: string,
    checkRunId: number,
  ): Promise<unknown[]>;
}

function createCheckRun(id: number): GhCheckRun {
  return {
    id,
    name: 'lint',
    status: 'completed',
    conclusion: 'success',
    html_url: `https://example.test/checks/${id}`,
    completed_at: '2026-05-12T00:00:00Z',
    output: { annotations_count: 1 },
  };
}

describe('PRPollingSource annotation drain', () => {
  it('propagates annotation rate limits to the base poller backoff path', async () => {
    const source = new PRPollingSource() as unknown as AnnotationDrainSource;
    const run = createCheckRun(42);
    const state: AnnotationDrainState = {
      pr: { owner: 'owner', repo: 'repo', pullNumber: 7 },
      slug: 'owner/repo',
      listeners: new Set(),
      pendingAnnotationRuns: [run],
    };
    const rateLimit = new GitHubRateLimitError(1_800_000_000);
    source.fetchAnnotations = vi.fn().mockRejectedValue(rateLimit);

    await expect(source.drainAnnotationQueue(state)).rejects.toBe(rateLimit);
    expect(source.fetchAnnotations).toHaveBeenCalledWith('owner', 'repo', 42);
    expect(state.pendingAnnotationRuns).toEqual([run]);
  });
});
