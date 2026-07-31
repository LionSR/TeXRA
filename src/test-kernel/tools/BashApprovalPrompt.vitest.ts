// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { BashPermissionSchema, type StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  prepareBashApprovalPrompt,
  setBashApprovalSessionBypass,
} from '@tools/approval/bashApproval';

const sid = (s: string): StreamTabId => s as StreamTabId;

describe('prepareBashApprovalPrompt', () => {
  it('builds a schema-valid payload with a unique prefixed request id', () => {
    const first = prepareBashApprovalPrompt({
      command: 'lake build',
      cwd: '/work',
      streamId: sid('s:bash-prompt'),
    });
    const second = prepareBashApprovalPrompt({ command: 'lake build' });

    expect(BashPermissionSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      command: 'lake build',
      cwd: '/work',
      allowBypass: true,
      streamId: 's:bash-prompt',
    });
    expect(first.requestId).toMatch(/^bash-.+/);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.streamId).toBe('');
  });

  it('omits a blank or whitespace-only working directory', () => {
    expect(
      prepareBashApprovalPrompt({ command: 'echo hi' }),
    ).not.toHaveProperty('cwd');
    expect(
      prepareBashApprovalPrompt({ command: 'echo hi', cwd: '   ' }),
    ).not.toHaveProperty('cwd');
    expect(
      prepareBashApprovalPrompt({ command: 'echo hi', cwd: ' /work ' }).cwd,
    ).toBe('/work');
  });

  it('drops the bypass affordance for an already-bypassed stream', () => {
    const session = createTestSession();
    const streamId = sid('s:bash-prompt-bypassed');
    setBashApprovalSessionBypass(streamId, true, { silent: true, session });

    expect(
      prepareBashApprovalPrompt({ command: 'echo hi', streamId }, session)
        .allowBypass,
    ).toBe(false);
    expect(
      prepareBashApprovalPrompt(
        { command: 'echo hi', streamId: sid('s:bash-prompt-other') },
        session,
      ).allowBypass,
    ).toBe(true);
  });
});
