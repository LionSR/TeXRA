/**
 * Agent review — the cross-host public surface of `src/agent/review`.
 *
 * One curated barrel the hosts import instead of deep-reaching each review
 * module by path: collecting the diff under review (`collectReviewDiff`,
 * `isPathInChangeSet`, `listBaseBranchCandidates`) and the issue vocabulary
 * hosts render and act on (`createReviewIssue`, `normalizeReviewFilePath`,
 * `buildReviewInstruction`, `buildFixInstruction`, plus the `ReviewIssue` /
 * `ReviewIssueReport` / `ReviewSeverity` types) — decoupling host code from
 * the review internals' file layout, per the module-level barrel pattern set
 * by `@agent/runtime` (#10011) and `@agent/followUp`. The R-b deep-import
 * width ratchet (`config/ratchets/host-agent-import-baseline.json`) records
 * each host's single `@agent/review` specifier; the former
 * `@agent/review/{reviewDiff,reviewIssues}` deep imports collapsed to this
 * door.
 *
 * Internal review modules keep importing each other by direct path; nothing
 * inside `src/agent` imports this barrel, so it introduces no import cycle.
 */

export {
  collectReviewDiff,
  isPathInChangeSet,
  listBaseBranchCandidates,
} from './reviewDiff';
export {
  buildFixInstruction,
  buildReviewInstruction,
  createReviewIssue,
  normalizeReviewFilePath,
  type ReviewIssue,
  type ReviewIssueReport,
  type ReviewSeverity,
} from './reviewIssues';
