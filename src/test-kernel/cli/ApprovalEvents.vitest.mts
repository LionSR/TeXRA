import { describe, expect, it } from 'vitest';

import {
  CLI_APPROVAL_EVENTS,
  CLI_DECISION_APPROVAL_EVENTS,
  CLI_HUMAN_INPUT_APPROVAL_EVENTS,
  cliApprovalEventKind,
  isCliApprovalEvent,
  isCliDecisionApprovalEvent,
} from '@cli/runtime/approvalEvents';

describe('CLI approval event taxonomy', () => {
  it('keeps decision and human-input approvals as disjoint subsets', () => {
    expect(CLI_APPROVAL_EVENTS).toEqual([
      'showBashPermission',
      'showPlanApproval',
      'showAgentProposal',
      'showRetryRequest',
      'showExternalInquiry',
    ]);

    const decisionEvents: ReadonlySet<string> = new Set(
      CLI_DECISION_APPROVAL_EVENTS,
    );
    for (const event of CLI_HUMAN_INPUT_APPROVAL_EVENTS) {
      expect(decisionEvents.has(event)).toBe(false);
    }
  });

  it('identifies approval-like progress events', () => {
    expect(isCliDecisionApprovalEvent('showBashPermission')).toBe(true);
    expect(isCliDecisionApprovalEvent('showExternalInquiry')).toBe(false);

    expect(isCliApprovalEvent('showExternalInquiry')).toBe(true);
    expect(isCliApprovalEvent('showUserQuestion')).toBe(false);
    expect(isCliApprovalEvent('updateStreamStatus')).toBe(false);
  });

  it('maps progress event names to TUI approval payload kinds', () => {
    expect(cliApprovalEventKind('showBashPermission')).toBe('bash');
    expect(cliApprovalEventKind('showPlanApproval')).toBe('plan');
    expect(cliApprovalEventKind('showAgentProposal')).toBe('proposal');
    expect(cliApprovalEventKind('showRetryRequest')).toBe('retry');
    expect(cliApprovalEventKind('showExternalInquiry')).toBe('externalInquiry');
  });
});
