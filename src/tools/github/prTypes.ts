/**
 * Minimal subset of GitHub REST response shapes used by the PR poller.
 * Only the fields we consume are declared; extra fields are tolerated
 * (z.looseObject). The schemas are the single source of truth — the types are
 * derived via z.infer. Always-present-but-nullable fields use .nullable();
 * fields GitHub may omit or send as explicit null use .nullish(); `state`
 * is a permissive transform, never a strict enum, so a novel value coerces
 * instead of throwing on the 200 path (a throw there would risk the pollers'
 * 24h detach).
 */
import { z } from 'zod';

const GhUserSchema = z.looseObject({
  login: z.string(),
  /** 'User' | 'Bot' | 'Organization' — used by the bot filter to drop CI noise. */
  type: z.string().nullish(),
});
export type GhUser = z.infer<typeof GhUserSchema>;

const GhIssueCommentSchema = z.looseObject({
  id: z.number(),
  body: z.string().nullable(),
  user: GhUserSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  html_url: z.string(),
  /**
   * Canonical link to the parent issue (PRs are issues internally), e.g.
   * `https://api.github.com/repos/o/r/issues/{number}`. Always present on
   * `/issues/comments` responses; preferred over `html_url` for parsing the
   * target number because `html_url` shape varies between issue and PR
   * comments depending on GitHub's redirect behavior.
   */
  issue_url: z.string().nullish(),
});
export type GhIssueComment = z.infer<typeof GhIssueCommentSchema>;

const GhReviewCommentSchema = z.looseObject({
  id: z.number(),
  body: z.string().nullable(),
  user: GhUserSchema.nullable(),
  path: z.string(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  in_reply_to_id: z.number().nullish(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
});
export type GhReviewComment = z.infer<typeof GhReviewCommentSchema>;

const GhReviewSchema = z.looseObject({
  id: z.number(),
  body: z.string().nullable(),
  // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING — kept a
  // permissive string so a novel review state never throws on the 200 path.
  state: z.string(),
  user: GhUserSchema.nullable(),
  html_url: z.string(),
  submitted_at: z.string().nullable(),
});
export type GhReview = z.infer<typeof GhReviewSchema>;

const GhCheckRunOutputSchema = z.looseObject({
  /** Treat undefined / null / 0 as "no annotations to fetch". */
  annotations_count: z.number().nullish(),
});

const GhCheckRunSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  status: z.string(), // queued, in_progress, completed
  conclusion: z.string().nullable(), // success, failure, cancelled, timed_out, ...
  html_url: z.string(),
  completed_at: z.string().nullable(),
  /** Surfaced for `annotations_count` so the poller can skip the separate
   * annotations endpoint on the common case of zero annotations. */
  output: GhCheckRunOutputSchema.nullish(),
});
export type GhCheckRun = z.infer<typeof GhCheckRunSchema>;

/**
 * Subset of `GET /repos/{o}/{r}/check-runs/{id}/annotations` we consume.
 * GitHub renders these as inline warning/notice bubbles on the PR diff view.
 */
export const GhCheckAnnotationSchema = z.looseObject({
  path: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  start_column: z.number().nullish(),
  end_column: z.number().nullish(),
  /** notice | warning | failure (per GitHub); tolerate unexpected values. */
  annotation_level: z.string().nullable(),
  title: z.string().nullish(),
  message: z.string(),
});
export type GhCheckAnnotation = z.infer<typeof GhCheckAnnotationSchema>;

/**
 * Permissive PR/issue `state`: a novel GitHub value must coerce to a known
 * value, never throw. A throw on the 200 path would strand lastSuccessAt and
 * risk the pollers' 24h detach. Anything that isn't exactly 'closed' is
 * treated as open.
 */
const OpenClosedStateSchema = z
  .string()
  .transform((s): 'open' | 'closed' => (s === 'closed' ? 'closed' : 'open'));

export const GhPullRequestSchema = z.looseObject({
  state: OpenClosedStateSchema,
  merged: z.boolean(),
  mergeable_state: z.string().nullish(),
  head: z.looseObject({ sha: z.string() }),
});
export type GhPullRequest = z.infer<typeof GhPullRequestSchema>;

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
export const GhIssueSchema = z.looseObject({
  number: z.number(),
  state: OpenClosedStateSchema,
  /** GitHub: `completed | not_planned | reopened | null`. */
  state_reason: z.string().nullish(),
  title: z.string(),
  html_url: z.string(),
  user: GhUserSchema.nullable(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
});
export type GhIssue = z.infer<typeof GhIssueSchema>;

/**
 * Subset of `GET /repos/{o}/{r}/pulls` list-entry fields used by the repo
 * poller for open/close/merge transition detection. Note: the list endpoint
 * does NOT return `merged` (that's only on the single-PR endpoint), so we
 * rely on `merged_at` to distinguish merged-closed from plain closed.
 */
const GhPullsListEntrySchema = z.looseObject({
  number: z.number(),
  state: OpenClosedStateSchema,
  title: z.string(),
  html_url: z.string(),
  user: GhUserSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  merged_at: z.string().nullable(),
});
export type GhPullsListEntry = z.infer<typeof GhPullsListEntrySchema>;

/** Array wrappers consumed by the repo poller's non-throwing boundary parse. */
export const GhIssueCommentArraySchema = z.array(GhIssueCommentSchema);
export const GhReviewCommentArraySchema = z.array(GhReviewCommentSchema);
export const GhPullsListEntryArraySchema = z.array(GhPullsListEntrySchema);
