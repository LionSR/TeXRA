import { describe, expect, it } from 'vitest';

import {
  formatCliApprovalPolicy,
  parseCliApprovalPolicy,
} from '@cli/runtime/approvalPolicyText';

describe('CLI approval policy text', () => {
  it('formats policies for session-facing CLI text', () => {
    expect(formatCliApprovalPolicy('ask')).toBe(
      'ask before privileged actions',
    );
    expect(formatCliApprovalPolicy('never')).toBe('deny privileged actions');
    expect(formatCliApprovalPolicy('yolo')).toBe(
      'auto-approve privileged actions',
    );
  });

  it('parses canonical policies and slash-command aliases', () => {
    expect(parseCliApprovalPolicy('ask')).toBe('ask');
    expect(parseCliApprovalPolicy('NEVER')).toBe('never');
    expect(parseCliApprovalPolicy(' yolo ')).toBe('yolo');
    expect(parseCliApprovalPolicy('default')).toBe('ask');
    expect(parseCliApprovalPolicy('interactive')).toBe('ask');
    expect(parseCliApprovalPolicy('on')).toBe('ask');
    expect(parseCliApprovalPolicy('off')).toBe('never');
    expect(parseCliApprovalPolicy('deny')).toBe('never');
    expect(parseCliApprovalPolicy('auto')).toBe('yolo');
    expect(parseCliApprovalPolicy('full')).toBe('yolo');
    expect(parseCliApprovalPolicy('danger')).toBe('yolo');
    expect(parseCliApprovalPolicy('sometimes')).toBeUndefined();
  });
});
