/**
 * Agent follow-up — the cross-host public surface of `packages/harness/src/agent/followUp`.
 *
 * One curated barrel the hosts (CLI, desktop, extension) import instead of
 * deep-reaching each follow-up module by path: resuming a run on its
 * session (`resumeOnSession`) and wording a refusal
 * (`describeFollowUpFailure`, `presentFollowUpResult`), decoupling host code
 * from the follow-up internals' file layout, per the module-level barrel
 * pattern set by `@agent/runtime` (#10011). The harness deep-import ratchet
 * (`config/ratchets/harness-deep-import-baseline.json`) records each host's
 * single `@agent/followUp` specifier.
 *
 * Internal follow-up modules keep importing each other by direct path;
 * nothing inside `src/agent` imports this barrel, so it introduces no import
 * cycle.
 */

export {
  describeFollowUpFailure,
  presentFollowUpResult,
  resumeOnSession,
} from './ToolUseFollowUp';
