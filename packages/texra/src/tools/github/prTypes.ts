/**
 * Minimal subset of GitHub REST response shapes used by the PR poller.
 * Only the fields we consume are declared; a `Schema.Struct` ignores the
 * rest of what GitHub sends. The schemas are the single source of truth — the
 * types are derived from them. Always-present-but-nullable fields use
 * `Schema.NullOr`; fields GitHub may omit or send as explicit null use
 * `Schema.optional(Schema.NullOr(...))`; `state`
 * is a permissive transform, never a strict enum, so a novel value coerces
 * instead of throwing on the 200 path (a throw there would risk the pollers'
 * 24h detach).
 */
import { Schema, SchemaGetter } from 'effect';

const GhUserSchema = Schema.Struct({
  login: Schema.String,
  /** 'User' | 'Bot' | 'Organization' — used by the bot filter to drop CI noise. */
  type: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GhUser = typeof GhUserSchema.Type;

const GhIssueCommentSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.NullOr(Schema.String),
  user: Schema.NullOr(GhUserSchema),
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  /**
   * Canonical link to the parent issue (PRs are issues internally), e.g.
   * `https://api.github.com/repos/o/r/issues/{number}`. Always present on
   * `/issues/comments` responses; preferred over `html_url` for parsing the
   * target number because `html_url` shape varies between issue and PR
   * comments depending on GitHub's redirect behavior.
   */
  issue_url: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GhIssueComment = typeof GhIssueCommentSchema.Type;

const GhReviewCommentSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.NullOr(Schema.String),
  user: Schema.NullOr(GhUserSchema),
  path: Schema.String,
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  original_line: Schema.optional(Schema.NullOr(Schema.Number)),
  in_reply_to_id: Schema.optional(Schema.NullOr(Schema.Number)),
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GhReviewComment = typeof GhReviewCommentSchema.Type;

const GhReviewSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.NullOr(Schema.String),
  // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING — kept a
  // permissive string so a novel review state never throws on the 200 path.
  state: Schema.String,
  user: Schema.NullOr(GhUserSchema),
  html_url: Schema.String,
  submitted_at: Schema.NullOr(Schema.String),
});
export type GhReview = typeof GhReviewSchema.Type;

const GhCheckRunOutputSchema = Schema.Struct({
  /** Treat undefined / null / 0 as "no annotations to fetch". */
  annotations_count: Schema.optional(Schema.NullOr(Schema.Number)),
});

const GhCheckRunSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String, // queued, in_progress, completed
  conclusion: Schema.NullOr(Schema.String), // success, failure, cancelled, timed_out, ...
  html_url: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  /** Surfaced for `annotations_count` so the poller can skip the separate
   * annotations endpoint on the common case of zero annotations. */
  output: Schema.optional(Schema.NullOr(GhCheckRunOutputSchema)),
});
export type GhCheckRun = typeof GhCheckRunSchema.Type;

/**
 * Subset of `GET /repos/{o}/{r}/check-runs/{id}/annotations` we consume.
 * GitHub renders these as inline warning/notice bubbles on the PR diff view.
 */
const GhCheckAnnotationSchema = Schema.Struct({
  path: Schema.String,
  start_line: Schema.Number,
  end_line: Schema.Number,
  start_column: Schema.optional(Schema.NullOr(Schema.Number)),
  end_column: Schema.optional(Schema.NullOr(Schema.Number)),
  /** notice | warning | failure (per GitHub); tolerate unexpected values. */
  annotation_level: Schema.NullOr(Schema.String),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.String,
});
export type GhCheckAnnotation = typeof GhCheckAnnotationSchema.Type;
export const GhCheckAnnotationArraySchema = Schema.Array(
  GhCheckAnnotationSchema,
);

/**
 * Permissive PR/issue `state`: a novel GitHub value must coerce to a known
 * value, never fail the decode (which skips the resource; see `pollGet`).
 * Anything that isn't exactly
 * 'closed' is treated as open.
 */
const OpenClosedStateSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.Literals(['open', 'closed']), {
    decode: SchemaGetter.transform((s): 'open' | 'closed' =>
      s === 'closed' ? 'closed' : 'open',
    ),
    // A GitHub response is read one way; nothing encodes a state back.
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
);

export const GhPullRequestSchema = Schema.Struct({
  state: OpenClosedStateSchema,
  merged: Schema.Boolean,
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
  head: Schema.Struct({ sha: Schema.String }),
});
export type GhPullRequest = typeof GhPullRequestSchema.Type;

/**
 * GitHub computes `mergeable_state` asynchronously after every push or base
 * change; until it stabilizes the field reads `'unknown'`. Both polling
 * sources filter out that transient value so a clean→unknown→dirty (or
 * dirty→unknown→clean) sequence registers as a single transition rather
 * than two — recording `'unknown'` as the prior state would mask the
 * resolved-side transition.
 */
export function isDefiniteMergeableState(
  s: string | null | undefined,
): s is string {
  return s != null && s !== 'unknown';
}

/**
 * Subset of `GET /repos/{o}/{r}/issues/{n}` we consume. The `pull_request`
 * field is GitHub's discriminator: present (with a `url`) iff this issue
 * record is actually a PR. The disambiguator on subscribe uses it.
 */
export const GhIssueSchema = Schema.Struct({
  number: Schema.Number,
  state: OpenClosedStateSchema,
  /** GitHub: `completed | not_planned | reopened | null`. */
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.String,
  html_url: Schema.String,
  user: Schema.NullOr(GhUserSchema),
  pull_request: Schema.optional(
    Schema.NullOr(Schema.Struct({ url: Schema.String })),
  ),
});
export type GhIssue = typeof GhIssueSchema.Type;

/**
 * Subset of `GET /repos/{o}/{r}/pulls` list-entry fields used by the repo
 * poller for open/close/merge transition detection. Note: the list endpoint
 * does NOT return `merged` (that's only on the single-PR endpoint), so we
 * rely on `merged_at` to distinguish merged-closed from plain closed.
 */
const GhPullsListEntrySchema = Schema.Struct({
  number: Schema.Number,
  state: OpenClosedStateSchema,
  title: Schema.String,
  html_url: Schema.String,
  user: Schema.NullOr(GhUserSchema),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  merged_at: Schema.NullOr(Schema.String),
});
export type GhPullsListEntry = typeof GhPullsListEntrySchema.Type;

/** Array wrappers consumed by the repo poller's non-throwing boundary parse. */
export const GhIssueCommentArraySchema = Schema.Array(GhIssueCommentSchema);
export const GhReviewArraySchema = Schema.Array(GhReviewSchema);
/** One page of `GET …/commits/{sha}/check-runs`. */
export const GhCheckRunsPageSchema = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(GhCheckRunSchema),
});
export const GhReviewCommentArraySchema = Schema.Array(GhReviewCommentSchema);
export const GhPullsListEntryArraySchema = Schema.Array(GhPullsListEntrySchema);
