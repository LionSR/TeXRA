/**
 * Natural-language formatting for PR webhook-style events.
 *
 * Each `format*` function declares a single message: a headline, optional
 * body, optional URL, all composed via `sections(...)` and wrapped in the
 * `<github-webhook-activity>` envelope. Variants (review verbs, passing
 * conclusions, prefixes) live as data tables at the top of the file rather
 * than inline ternary cascades — adding a new review state or passing
 * conclusion is a one-line table edit.
 */

import { unique } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

import {
  authorOf,
  formatCommentEvent,
  formatPreviousStateHint,
  makeTruncator,
  sections,
  truncate as truncateBody,
  wrapWebhookEvent as wrap,
} from './formatUtils';
import { prRef } from './githubPaths';
import { formatCheckAnnotationLevelList } from './checkAnnotationLevels';
import { isPassingConclusion } from './prCheckRunDomain';
import type {
  GhCheckAnnotation,
  GhCheckRun,
  GhIssueComment,
  GhReview,
  GhReviewComment,
} from './prTypes';

const MAX_BODY = 500;
// A single linter run can emit hundreds; show the first N + overflow hint.
const MAX_ANNOTATIONS_PER_RUN = 20;
const MAX_CI_STARTED_CHECK_NAMES = 20;
const MAX_ANNOTATION_MESSAGE = 300;

const truncate = makeTruncator(MAX_BODY);

/** Verb fragments per `GhReview.state`. Unknown states fall back to "reviewed". */
const REVIEW_VERBS: Readonly<Record<string, string>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes on',
  COMMENTED: 'commented on',
  DISMISSED: 'dismissed a review on',
};

const FALLBACK_REVIEW_VERB = 'reviewed';

const reviewCommentLocation = (c: GhReviewComment): string => {
  const line = c.line ?? c.original_line;
  return line ? `${c.path}:${line}` : c.path;
};

const reviewCommentPrefix = (c: GhReviewComment): string =>
  c.in_reply_to_id != null
    ? 'Reply to inline review thread'
    : 'New line review comment';

const checkRunBlock = (run: GhCheckRun): string =>
  `Check: ${run.name}\nConclusion: ${run.conclusion}\nDetails: ${run.html_url}`;

const annotationLocation = (a: GhCheckAnnotation): string => {
  if (a.end_line > a.start_line) {
    return `${a.path}:${a.start_line}-${a.end_line}`;
  }
  // Per GitHub: start_column / end_column are only meaningful when
  // start_line === end_line. Include them so multiple annotations on
  // different columns of the same line stay distinguishable.
  if (a.start_column != null) {
    const colRange =
      a.end_column != null && a.end_column !== a.start_column
        ? `${a.start_column}-${a.end_column}`
        : `${a.start_column}`;
    return `${a.path}:${a.start_line}:${colRange}`;
  }
  return `${a.path}:${a.start_line}`;
};

const annotationBlock = (a: GhCheckAnnotation): string => {
  const level = (a.annotation_level ?? 'notice').toUpperCase();
  const title = a.title ? `${a.title}: ` : '';
  const message = truncateBody(a.message, MAX_ANNOTATION_MESSAGE);
  return `[${level}] ${annotationLocation(a)}\n${title}${message}`;
};

/**
 * GitHub delivers general PR comments over the same `issue_comment` webhook
 * as plain-issue comments (a PR *is* an issue under the REST API). Named
 * `formatPRIssueComment` — not `formatIssueComment` — to stay distinct from
 * `formatIssueEvent.ts`'s same-signature `formatIssueComment`; the two are
 * not interchangeable (wrong one renders `pulls/N` where `issues/N` is
 * expected, or vice versa) and TypeScript can't catch the swap since both
 * take `(slug: string, number: number, c: GhIssueComment): string`.
 */
export function formatPRIssueComment(
  slug: string,
  prNumber: number,
  c: GhIssueComment,
): string {
  return formatCommentEvent(prRef(slug, prNumber), c, MAX_BODY);
}

export function formatReviewComment(
  slug: string,
  prNumber: number,
  c: GhReviewComment,
): string {
  return wrap(
    sections(
      `${reviewCommentPrefix(c)} on ${prRef(slug, prNumber)} by ${authorOf(c.user)} at ${reviewCommentLocation(c)}:`,
      truncate(c.body),
      c.html_url,
    ),
  );
}

export function formatReview(
  slug: string,
  prNumber: number,
  r: GhReview,
): string {
  const verb = REVIEW_VERBS[r.state] ?? FALLBACK_REVIEW_VERB;
  return wrap(
    sections(
      `${authorOf(r.user)} ${verb} ${prRef(slug, prNumber)}.`,
      r.body && truncate(r.body),
      r.html_url,
    ),
  );
}

export function formatCheckFailure(
  slug: string,
  prNumber: number,
  run: GhCheckRun,
): string {
  return wrap(
    sections(
      'The following CI check failed on the PR. Investigate the failure and determine what action (if any) is needed.',
      `PR: ${prRef(slug, prNumber)}\n${checkRunBlock(run)}`,
    ),
  );
}

export function formatCheckFailureSummary(
  slug: string,
  prNumber: number,
  runs: GhCheckRun[],
): string {
  return wrap(
    sections(
      `${runs.length} CI checks failed on the PR. Investigate the failures and determine what action (if any) is needed.`,
      `PR: ${prRef(slug, prNumber)}`,
      runs.map(checkRunBlock).join('\n\n'),
    ),
  );
}

/**
 * Emitted separately from `formatCheckFailure` because annotations also
 * appear on *passing* checks — many workflows surface non-blocking lint /
 * suggestion advisories against specific lines without failing the build.
 */
export function formatCheckAnnotations(
  slug: string,
  prNumber: number,
  run: GhCheckRun,
  annotations: ReadonlyArray<GhCheckAnnotation>,
): string {
  const total = run.output?.annotations_count ?? annotations.length;
  const shown = annotations.slice(0, MAX_ANNOTATIONS_PER_RUN);
  const remaining = total - shown.length;
  const overflow =
    remaining > 0
      ? `…and ${remaining} more annotation(s). See ${run.html_url} for the full list.`
      : run.html_url;
  return wrap(
    sections(
      `Check "${run.name}" reported ${total} matching inline annotation(s) on ${prRef(slug, prNumber)}. Each annotation is tagged with its level (${formatCheckAnnotationLevelList(annotations)}); investigate and determine what action (if any) is needed.`,
      shown.map(annotationBlock).join('\n\n'),
      overflow,
    ),
  );
}

export function formatCIPassed(
  slug: string,
  prNumber: number,
  sha: string,
  runs: GhCheckRun[],
): string {
  return wrap(
    `All ${runs.length} CI checks passed on ${prRef(slug, prNumber)} (head ${sha.slice(0, 7)}).`,
  );
}

export function formatCIStarted(
  slug: string,
  prNumber: number,
  sha: string,
  runs: GhCheckRun[],
  totalCount: number,
): string {
  const uniqueNames = unique(runs.map((r) => r.name)).sort();
  const shownNames = uniqueNames.slice(0, MAX_CI_STARTED_CHECK_NAMES);
  const remainingNames = uniqueNames.length - shownNames.length;
  const body = [
    ...shownNames.map((name) => `- ${name}`),
    ...(remainingNames > 0
      ? [`…and ${formatResultCount(remainingNames, 'more check name')}.`]
      : []),
  ].join('\n');

  return wrap(
    sections(
      `CI triggered on ${prRef(slug, prNumber)} (head ${sha.slice(0, 7)}): GitHub reports ${formatResultCount(totalCount, 'check')} registered; this poll observed ${formatResultCount(runs.length, 'check')} across ${formatResultCount(uniqueNames.length, 'distinct check name')}.`,
      body,
    ),
  );
}

export function formatCIComplete(
  slug: string,
  prNumber: number,
  sha: string,
  runs: GhCheckRun[],
): string {
  const passed = runs.filter((r) => isPassingConclusion(r.conclusion)).length;
  const failed = runs.length - passed;
  return wrap(
    `CI completed on ${prRef(slug, prNumber)} (head ${sha.slice(0, 7)}): ${passed} passed, ${failed} failed.`,
  );
}

export function formatPRClosed(
  slug: string,
  prNumber: number,
  merged: boolean,
): string {
  return wrap(
    `${prRef(slug, prNumber)} was ${merged ? 'merged' : 'closed'}. Subscription ended.`,
  );
}

/**
 * Emitted when GitHub flips `mergeable_state` to `dirty` (the head can no
 * longer be merged into the base without conflict). Triggered by either a
 * push to the head branch or a change to the base branch landing
 * conflicting content. The agent typically wants to either rebase or merge
 * the base branch back in.
 */
export function formatMergeConflictDetected(
  slug: string,
  prNumber: number,
  prevState: string | undefined,
): string {
  return wrap(
    `Merge conflict detected on ${prRef(slug, prNumber)}: GitHub now reports mergeable_state="dirty"${formatPreviousStateHint(prevState)}. ` +
      `The PR head no longer cleanly merges into its base: rebase or merge the base back in to resolve.`,
  );
}

/**
 * Emitted when a previously-dirty PR returns to a non-dirty state (typically
 * after a rebase / merge of the base, or after the conflicting change is
 * reverted). Pairs with `formatMergeConflictDetected` so an agent that acted
 * on the conflict notification gets a clean "resolved" signal too.
 */
export function formatMergeConflictResolved(
  slug: string,
  prNumber: number,
  newState: string,
): string {
  return wrap(
    `Merge conflict on ${prRef(slug, prNumber)} is resolved: mergeable_state is now "${newState}".`,
  );
}

/**
 * Error events delivered into the follow-up queue when the poller hits an
 * unrecoverable condition (auth rejected, repeated failures). Same
 * `<github-webhook-activity>` envelope + sanitize path as every other event
 * so agents can't mistake these for direct user input and so an adversarial
 * GitHub error payload can't inject tag-shaped content unsanitized.
 */
export function formatSubscriptionError(
  slug: string,
  prNumber: number,
  detail: string,
): string {
  return wrap(`PR subscription to ${prRef(slug, prNumber)} halted: ${detail}`);
}
