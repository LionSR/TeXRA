import type { ApprovalBypassKind } from '@shared/approvalBypassKind';

/**
 * What each run-scoped grant approves, one noun per approval kind: edits,
 * commands, agent work. The approval cards' Approve ▾ menu, the header's
 * grant chips and the CLI's `/status` name the same grant with the same noun.
 */
/** The one order grants are listed in, on every surface. */
export const RUN_GRANT_ORDER = [
  'toolEdit',
  'bash',
  'superYolo',
] as const satisfies readonly ApprovalBypassKind[];

export const RUN_GRANT_NOUN = Object.freeze({
  toolEdit: 'edits',
  bash: 'commands',
  superYolo: 'agent work',
} as const satisfies Record<ApprovalBypassKind, string>);

/** The approval card's grant item, e.g. "Approve all edits in this task". */
export const RUN_GRANT_LABEL = Object.freeze({
  toolEdit: `Approve all ${RUN_GRANT_NOUN.toolEdit} in this task`,
  bash: `Approve all ${RUN_GRANT_NOUN.bash} in this task`,
  superYolo: `Approve all ${RUN_GRANT_NOUN.superYolo} in this task`,
} as const satisfies Record<ApprovalBypassKind, string>);

/**
 * A grant once given: granting has one home (the approval card's Approve ▾,
 * the CLI card's `a`); the header's read-only chip and the CLI's
 * `/approval` show it and revoke it.
 */
export const RUN_GRANT_COPY = Object.freeze({
  label: (kind: ApprovalBypassKind) => `Auto: ${RUN_GRANT_NOUN[kind]}`,
  /** The one chip a narrow header shows for every grant on. */
  compactLabel: 'Auto',
  tooltip: (kinds: readonly ApprovalBypassKind[]) =>
    `This task approves ${kinds.map((kind) => RUN_GRANT_NOUN[kind]).join(', ')} without asking. Remove to ask again.`,
  revoke: (kind: ApprovalBypassKind) =>
    `Stop auto-approving ${RUN_GRANT_NOUN[kind]}`,
});

/** Host-specific user copy for the delegated-work approval grant. */
export const DELEGATION_APPROVAL_COPY = Object.freeze({
  cliAction: 'approve agent work for this task',
  cliCompactAction: 'all agent work',
  cliExplanation:
    'Press y to approve only this agent. Press a to approve agent work, file edits, and commands for this task. Other prompts still ask.',
  progressViewToggle:
    'Auto-approve later agent work, file edits, and shell commands in this task',
} as const);

/**
 * Host-specific user copy for the plan "Run as Goal" grant. Commands-only is
 * the shared default; the CLI may explicitly broaden one goal to commands,
 * edits, and delegated work. `progressViewExplanation` is the clause that
 * follows the bolded action name in the panel, so it opens mid-sentence.
 */
export const PLAN_GOAL_COPY = Object.freeze({
  action: 'Run as Goal',
  progressViewExplanation:
    'keeps the agent working across turns until it completes the plan, needs your input, or you stop it. Only Bash commands are auto-approved; edits and other actions still ask.',
  cliNotice: 'Runs until done; only Bash is automatic.',
} as const);
