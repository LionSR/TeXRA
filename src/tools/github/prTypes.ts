/**
 * Minimal subset of GitHub REST response shapes used by the PR poller.
 * Only the fields we consume are declared; extra fields are tolerated.
 */

export interface GhUser {
  login: string;
}

export interface GhIssueComment {
  id: number;
  body: string | null;
  user: GhUser | null;
  created_at: string;
  updated_at?: string;
  html_url: string;
}

export interface GhReviewComment {
  id: number;
  body: string | null;
  user: GhUser | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
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
