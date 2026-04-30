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

export interface GhCheckRun {
  id: number;
  name: string;
  status: string; // queued, in_progress, completed
  conclusion: string | null; // success, failure, cancelled, timed_out, ...
  html_url: string;
  completed_at: string | null;
}

export interface GhPullRequest {
  state: 'open' | 'closed';
  merged: boolean;
  mergeable_state?: string;
  head: { sha: string };
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
