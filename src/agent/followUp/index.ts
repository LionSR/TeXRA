/**
 * Agent follow-up — the cross-host public surface of `src/agent/followUp`.
 *
 * One curated barrel the hosts (CLI, desktop, extension) import instead of
 * deep-reaching each follow-up module by path: submitting a follow-up to a
 * live or resumable stream (`submitFollowUp`), presenting the admission
 * outcome (`presentFollowUpResult`), and notifying that a queued follow-up
 * was sent (`notifyFollowUpSent`), plus the queue-input and recovery-lease
 * types hosts name at their session seams — decoupling host code from the
 * follow-up internals' file layout, per the module-level barrel pattern set
 * by `@agent/runtime` (#10011). The R-b deep-import width ratchet
 * (`config/ratchets/host-agent-import-baseline.json`) records each host's
 * single `@agent/followUp` specifier; the former `ToolUseFollowUp` and
 * `ToolUseFollowUpQueueManager` deep imports collapsed to this door.
 */

export {
  notifyFollowUpSent,
  presentFollowUpResult,
  submitFollowUp,
  type SubmitFollowUpResult,
} from './ToolUseFollowUp';
export type { FollowUpQueueInput } from './FollowUpQueue';
export type { FollowUpRecoveryLease } from './ToolUseFollowUpQueueManager';
