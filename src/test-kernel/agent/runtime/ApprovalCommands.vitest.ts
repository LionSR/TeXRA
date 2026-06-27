import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  resolveRuntimeBashApproval,
  setRuntimeBashApprovalSessionBypass,
  setRuntimeToolEditApprovalHandler,
  setRuntimeToolEditApprovalSessionBypass,
  type RuntimeToolEditApprovalHandler,
} from '@agent/runtime/approvalCommands';
import type { StreamTabId } from '@shared/schemas';
import {
  bashApprovalController,
  type BashApprovalResult,
  isBashApprovalBypassedForStream,
} from '@tools/approval/bashApproval';
import {
  isApprovalBypassedForStream,
  requestToolEditApproval,
} from '@tools/approval/toolEditApproval';

const STREAM_ID = 'runtime-approval-command-stream' as StreamTabId;

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('runtime approval commands', () => {
  afterEach(() => {
    const host = createRecordingHost();
    setRuntimeBashApprovalSessionBypass({
      streamId: STREAM_ID,
      enabled: false,
      runtimeHost: host,
      silent: true,
    });
    setRuntimeToolEditApprovalSessionBypass({
      streamId: STREAM_ID,
      enabled: false,
      runtimeHost: host,
      silent: true,
    });
    setRuntimeToolEditApprovalHandler();
    bashApprovalController.unregisterPending('runtime-bash-approval');
  });

  it('resolves a pending bash approval from a runtime command', async () => {
    let settled: BashApprovalResult | undefined;
    bashApprovalController.registerPending('runtime-bash-approval', {
      streamId: STREAM_ID,
      runtimeHost: createRecordingHost(),
      isSettled: () => settled !== undefined,
      settle: (result) => {
        settled = result;
      },
    });

    await resolveRuntimeBashApproval({
      requestId: 'runtime-bash-approval',
      action: 'reject',
      feedback: '  Use a non-shell method.  ',
    });

    expect(settled).toEqual({
      accepted: false,
      userMessage: 'Use a non-shell method.',
    });
  });

  it('sets runtime approval bypass state by stream', () => {
    const host = createRecordingHost();

    setRuntimeBashApprovalSessionBypass({
      streamId: STREAM_ID,
      enabled: true,
      runtimeHost: host,
      silent: true,
    });
    setRuntimeToolEditApprovalSessionBypass({
      streamId: STREAM_ID,
      enabled: true,
      runtimeHost: host,
      silent: true,
    });

    expect(isBashApprovalBypassedForStream(STREAM_ID)).toBe(true);
    expect(isApprovalBypassedForStream(STREAM_ID)).toBe(true);
  });

  it('installs the host-provided tool-edit approval handler', async () => {
    const handler: RuntimeToolEditApprovalHandler = vi.fn(async (request) => ({
      accepted: true,
      appliedContent: request.proposedContent,
    }));
    setRuntimeToolEditApprovalHandler(handler);

    await expect(
      requestToolEditApproval({
        path: 'proof.lean',
        originalContent: 'theorem t : True := by\n  trivial\n',
        proposedContent: 'theorem t : True := by\n  exact True.intro\n',
        sourceTool: 'edit_file',
        streamId: STREAM_ID,
      }),
    ).resolves.toMatchObject({
      accepted: true,
      appliedContent: 'theorem t : True := by\n  exact True.intro\n',
    });
    expect(handler).toHaveBeenCalledOnce();
  });
});
