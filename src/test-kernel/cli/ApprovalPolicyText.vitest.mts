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

  it('parses only the three documented policy names', () => {
    expect(parseCliApprovalPolicy('ask')).toBe('ask');
    expect(parseCliApprovalPolicy('NEVER')).toBe('never');
    expect(parseCliApprovalPolicy(' yolo ')).toBe('yolo');
    expect(parseCliApprovalPolicy('sometimes')).toBeUndefined();
    // Retired synonyms: `on`/`off` in particular never said which policy.
    for (const retired of [
      'default',
      'interactive',
      'on',
      'off',
      'deny',
      'auto',
      'full',
      'danger',
    ]) {
      expect(parseCliApprovalPolicy(retired)).toBeUndefined();
    }
  });
});
