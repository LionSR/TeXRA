import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';

// CLI hosts share the same progress-event names, but not the same handling.
// Decision approvals can be auto-approved or denied by policy; human-input
// prompts must be surfaced to the user when an interactive TTY is available.
export const CLI_DECISION_APPROVAL_EVENTS = [
  'showBashPermission',
  'showPlanApproval',
  'showAgentProposal',
  'showRetryRequest',
] as const satisfies readonly (keyof RuntimeInteractionEventPayloads)[];

export const CLI_HUMAN_INPUT_APPROVAL_EVENTS = [
  'showExternalInquiry',
] as const satisfies readonly (keyof RuntimeInteractionEventPayloads)[];

export const CLI_APPROVAL_EVENTS = [
  ...CLI_DECISION_APPROVAL_EVENTS,
  ...CLI_HUMAN_INPUT_APPROVAL_EVENTS,
] as const satisfies readonly (keyof RuntimeInteractionEventPayloads)[];

export const CLI_APPROVAL_EVENT_KIND = {
  showBashPermission: 'bash',
  showPlanApproval: 'plan',
  showAgentProposal: 'proposal',
  showRetryRequest: 'retry',
  showExternalInquiry: 'externalInquiry',
} as const satisfies Record<CliApprovalEvent, string>;

export type CliDecisionApprovalEvent =
  (typeof CLI_DECISION_APPROVAL_EVENTS)[number];
export type CliApprovalEvent = (typeof CLI_APPROVAL_EVENTS)[number];

const CLI_DECISION_APPROVAL_EVENT_SET: ReadonlySet<string> = new Set(
  CLI_DECISION_APPROVAL_EVENTS,
);
const CLI_APPROVAL_EVENT_SET: ReadonlySet<string> = new Set(
  CLI_APPROVAL_EVENTS,
);

export function isCliDecisionApprovalEvent(
  event: string,
): event is CliDecisionApprovalEvent {
  return CLI_DECISION_APPROVAL_EVENT_SET.has(event);
}

export function isCliApprovalEvent(event: string): event is CliApprovalEvent {
  return CLI_APPROVAL_EVENT_SET.has(event);
}

export function cliApprovalEventKind<E extends CliApprovalEvent>(
  event: E,
): (typeof CLI_APPROVAL_EVENT_KIND)[E] {
  return CLI_APPROVAL_EVENT_KIND[event];
}
