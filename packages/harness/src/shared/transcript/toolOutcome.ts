import type { ToolOutcomePermission } from '@shared/schemas';

/** What the call is called in the question: an agent call is "the agent". */
function subject(outcome: ToolOutcomePermission): string {
  return outcome.toolName === 'agent' ? 'the agent' : outcome.toolName;
}

/**
 * Copy for the request a call opens when it may have run before TeXRA
 * stopped and left no result (`toolOutcome`), shared by every host and by
 * the script card's row that waits on it.
 */
export const TOOL_OUTCOME_COPY = {
  question: (outcome: ToolOutcomePermission): string =>
    `Did ${subject(outcome)} finish before TeXRA stopped?`,
  explanation:
    'No result was recorded. Run again repeats it; Skip it tells the task its outcome is unknown.',
  runAgain: 'Run again',
  skip: 'Skip it',
  /** The script row's line while the request waits. */
  waiting: (outcome: ToolOutcomePermission): string =>
    `Wants a decision: did ${subject(outcome)} finish?`,
} as const;
