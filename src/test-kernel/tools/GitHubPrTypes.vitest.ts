import { describe, expect, it } from 'vitest';

import {
  GhCheckAnnotationSchema,
  GhIssueCommentArraySchema,
  GhIssueSchema,
  GhPullRequestSchema,
  GhReviewCommentArraySchema,
  isDefiniteMergeableState,
} from '@tools/github/prTypes';

describe('GitHub REST response schemas', () => {
  it('accepts null for optional fields GitHub may return as null', () => {
    expect(
      GhIssueCommentArraySchema.safeParse([
        {
          id: 1,
          body: null,
          user: { login: 'octocat', type: null },
          created_at: '2026-06-21T00:00:00Z',
          updated_at: null,
          html_url: 'https://github.com/LionSR/TeXRA/issues/1#issuecomment-1',
          issue_url: null,
        },
      ]).success,
    ).toBe(true);

    expect(
      GhReviewCommentArraySchema.safeParse([
        {
          id: 2,
          body: null,
          user: { login: 'reviewer', type: null },
          path: 'src/index.ts',
          line: null,
          original_line: null,
          in_reply_to_id: null,
          html_url: 'https://github.com/LionSR/TeXRA/pull/1#discussion_r2',
          created_at: '2026-06-21T00:00:00Z',
          updated_at: null,
        },
      ]).success,
    ).toBe(true);

    expect(
      GhPullRequestSchema.safeParse({
        state: 'open',
        merged: false,
        mergeable_state: null,
        head: { sha: 'abc123' },
      }).success,
    ).toBe(true);

    expect(
      GhIssueSchema.safeParse({
        number: 1,
        state: 'open',
        state_reason: null,
        title: 'Issue',
        html_url: 'https://github.com/LionSR/TeXRA/issues/1',
        user: null,
        pull_request: null,
      }).success,
    ).toBe(true);

    expect(
      GhCheckAnnotationSchema.safeParse({
        path: 'src/index.ts',
        start_line: 1,
        end_line: 1,
        start_column: null,
        end_column: null,
        annotation_level: null,
        title: null,
        message: 'message',
        raw_details: null,
        blob_href: null,
      }).success,
    ).toBe(true);

    expect(isDefiniteMergeableState(null)).toBe(false);
  });
});
