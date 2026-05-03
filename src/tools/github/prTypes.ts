/**
 * Minimal subset of GitHub REST response shapes used by the PR poller.
 * Only the fields we consume are declared; extra fields are tolerated.
 */

export interface GhUser {
  login: string;
  /** 'User' | 'Bot' | 'Organization' — used by the bot filter to drop CI noise. */
  type?: string;
}

export interface GhIssueComment {
  id: number;
  body: string | null;
  user: GhUser | null;
  created_at: string;
  updated_at?: string;
  html_url: string;
  /**
   * Canonical link to the parent issue (PRs are issues internally), e.g.
   * `https://api.github.com/repos/o/r/issues/{number}`. Always present on
   * `/issues/comments` responses; preferred over `html_url` for parsing the
   * target number because `html_url` shape varies between issue and PR
   * comments depending on GitHub's redirect behavior.
   */
  issue_url?: string;
}

export interface GhReviewComment {
  id: number;
  body: string | null;
  user: GhUser | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  in_reply_to_id?: number | null;
  html_url: string;
  created_at: string;
  updated_at?: string;
}

export interface GhReview {
  id: number;
  body: string | null;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING
  user: GhUser | null;
  html_url: string;
  submitted_at: string | null;
}

export interface GhCheckRunOutput {
  title?: string | null;
  summary?: string | null;
  /**
   * GitHub returns this as a number on the check-runs list endpoint, but it
   * can be 0 (or absent on partial responses). Treat undefined / null as 0.
   */
  annotations_count?: number | null;
  annotations_url?: string | null;
}

export interface GhCheckRun {
  id: number;
  name: string;
  status: string; // queued, in_progress, completed
  conclusion: string | null; // success, failure, cancelled, timed_out, ...
  html_url: string;
  completed_at: string | null;
  /**
   * Per-run output block. Surfaced for `annotations_count` so the poller can
   * decide whether to fetch the (separate, paginated) annotations endpoint
   * — saves an API call per tick on the common case of zero annotations.
   */
  output?: GhCheckRunOutput | null;
}

/**
 * Subset of `GET /repos/{o}/{r}/check-runs/{id}/annotations` we consume.
 * Annotations are GitHub's mechanism for pinning a `notice` / `warning` /
 * `failure` to a specific file path and line range — the same data that
 * renders as inline check-warning bubbles on the PR diff view (e.g. lint
 * suggestions, type errors, custom workflow hints).
 */
export interface GhCheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number | null;
  end_column?: number | null;
  /** notice | warning | failure (per GitHub); tolerate unexpected values. */
  annotation_level: string | null;
  title?: string | null;
  message: string;
  raw_details?: string | null;
  blob_href?: string;
}

export interface GhPullRequest {
  state: 'open' | 'closed';
  merged: boolean;
  mergeable_state?: string;
  head: { sha: string };
}

/**
 * GitHub computes `mergeable_state` asynchronously after every push or base
 * change; until it stabilizes the field reads `'unknown'`. Both polling
 * sources filter out that transient value so a clean→unknown→dirty (or
 * dirty→unknown→clean) sequence registers as a single transition rather
 * than two — recording `'unknown'` as the prior state would mask the
 * resolved-side transition.
 */
export function isDefiniteMergeableState(s: string | undefined): s is string {
  return s !== undefined && s !== 'unknown';
}

/**
 * Subset of `GET /repos/{o}/{r}/issues/{n}` we consume. The `pull_request`
 * field is GitHub's discriminator: present (with a `url`) iff this issue
 * record is actually a PR. The disambiguator on subscribe uses it.
 */
export interface GhIssue {
  number: number;
  state: 'open' | 'closed';
  /** GitHub: `completed | not_planned | reopened | null`. */
  state_reason?: string | null;
  title: string;
  html_url: string;
  user: GhUser | null;
  pull_request?: { url: string };
}

/**
 * Subset of `GET /repos/{o}/{r}/pulls` list-entry fields used by the repo
 * poller for open/close/merge transition detection. Note: the list endpoint
 * does NOT return `merged` (that's only on the single-PR endpoint), so we
 * rely on `merged_at` to distinguish merged-closed from plain closed.
 */
export interface GhPullsListEntry {
  number: number;
  state: 'open' | 'closed';
  title: string;
  html_url: string;
  user: GhUser | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
}
