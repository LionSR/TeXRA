import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyRuntimeApprovalDecisionBypass,
  getRuntimeApprovalBypassStatus,
  resolveRuntimeBashApproval,
  setRuntimeCoupledApprovalBypass,
  setRuntimeToolEditApprovalHandler,
  startRuntimeToolEditApprovalPrompt,
  toggleRuntimeCoupledApprovalBypass,
  toggleRuntimeDelegatedTaskApprovalBypass,
  type RuntimeToolEditApprovalHandler,
} from '@agent/runtime/approvalCommands';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupAllApprovals,
  cleanupApprovalsForStream,
} from '@tools/approval';
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
    cleanupAllApprovals();
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

    expect(
      applyRuntimeApprovalDecisionBypass({
        streamId: STREAM_ID,
        accepted: true,
        bypass: 'bash',
        runtimeHost: host,
      }),
    ).toEqual({
      status: 'applied',
      bypass: 'bash',
      streamId: STREAM_ID,
    });
    expect(
      applyRuntimeApprovalDecisionBypass({
        streamId: STREAM_ID,
        accepted: true,
        bypass: 'toolEdit',
        runtimeHost: host,
      }),
    ).toEqual({
      status: 'applied',
      bypass: 'toolEdit',
      streamId: STREAM_ID,
    });

    expect(isBashApprovalBypassedForStream(STREAM_ID)).toBe(true);
    expect(isApprovalBypassedForStream(STREAM_ID)).toBe(true);
  });

  it('ignores rejected, streamless, and no-bypass approval decisions', () => {
    const host = createRecordingHost();

    expect(
      applyRuntimeApprovalDecisionBypass({
        streamId: STREAM_ID,
        accepted: false,
        bypass: 'bash',
        runtimeHost: host,
      }),
    ).toEqual({
      status: 'ignored',
      reason: 'rejected',
      bypass: 'bash',
      streamId: STREAM_ID,
    });
    expect(
      applyRuntimeApprovalDecisionBypass({
        accepted: true,
        bypass: 'toolEdit',
        runtimeHost: host,
      }),
    ).toEqual({
      status: 'ignored',
      reason: 'no_stream',
      bypass: 'toolEdit',
    });
    expect(
      applyRuntimeApprovalDecisionBypass({
        streamId: STREAM_ID,
        accepted: true,
        runtimeHost: host,
      }),
    ).toEqual({
      status: 'ignored',
      reason: 'no_bypass',
      streamId: STREAM_ID,
    });

    expect(isBashApprovalBypassedForStream(STREAM_ID)).toBe(false);
    expect(isApprovalBypassedForStream(STREAM_ID)).toBe(false);
  });

  it('applies delegated-task decisions with implied edit and bash bypasses', () => {
    const host = createRecordingHost();

    expect(
      applyRuntimeApprovalDecisionBypass({
        streamId: STREAM_ID,
        accepted: true,
        bypass: 'superYolo',
        runtimeHost: host,
      }),
    ).toEqual({
      status: 'applied',
      bypass: 'superYolo',
      streamId: STREAM_ID,
    });

    expect(getRuntimeApprovalBypassStatus(STREAM_ID)).toEqual({
      toolEditBypass: true,
      delegatedTaskBypass: true,
    });
    expect(isBashApprovalBypassedForStream(STREAM_ID)).toBe(true);
    expect(host.emit).toHaveBeenNthCalledWith(1, 'updateSuperYoloBypassState', {
      streamId: STREAM_ID,
      bypassActive: true,
    });
    expect(host.emit).toHaveBeenNthCalledWith(
      2,
      'updateToolEditApprovalBypassState',
      {
        streamId: STREAM_ID,
        bypassActive: true,
      },
    );
  });

  it('keeps the coupled approval shield as one runtime transition', () => {
    const host = createRecordingHost();

    expect(
      toggleRuntimeCoupledApprovalBypass({
        streamId: STREAM_ID,
        runtimeHost: host,
      }),
    ).toBe(true);

    expect(getRuntimeApprovalBypassStatus(STREAM_ID)).toEqual({
      toolEditBypass: true,
      delegatedTaskBypass: false,
    });
    expect(isBashApprovalBypassedForStream(STREAM_ID)).toBe(true);
    expect(host.emit).toHaveBeenCalledOnce();
    expect(host.emit).toHaveBeenCalledWith(
      'updateToolEditApprovalBypassState',
      {
        streamId: STREAM_ID,
        bypassActive: true,
      },
    );

    expect(
      setRuntimeCoupledApprovalBypass({
        streamId: STREAM_ID,
        enabled: false,
        runtimeHost: host,
      }),
    ).toBe(false);

    expect(getRuntimeApprovalBypassStatus(STREAM_ID).toolEditBypass).toBe(
      false,
    );
    expect(isBashApprovalBypassedForStream(STREAM_ID)).toBe(false);
  });

  it('toggles delegated task approval with implied edit and bash bypasses', () => {
    const host = createRecordingHost();

    expect(
      toggleRuntimeDelegatedTaskApprovalBypass({
        streamId: STREAM_ID,
        runtimeHost: host,
      }),
    ).toBe(true);

    expect(getRuntimeApprovalBypassStatus(STREAM_ID)).toEqual({
      toolEditBypass: true,
      delegatedTaskBypass: true,
    });
    expect(isBashApprovalBypassedForStream(STREAM_ID)).toBe(true);
    expect(host.emit).toHaveBeenNthCalledWith(1, 'updateSuperYoloBypassState', {
      streamId: STREAM_ID,
      bypassActive: true,
    });
    expect(host.emit).toHaveBeenNthCalledWith(
      2,
      'updateToolEditApprovalBypassState',
      {
        streamId: STREAM_ID,
        bypassActive: true,
      },
    );

    expect(
      toggleRuntimeDelegatedTaskApprovalBypass({
        streamId: STREAM_ID,
        runtimeHost: host,
      }),
    ).toBe(false);

    expect(getRuntimeApprovalBypassStatus(STREAM_ID)).toEqual({
      toolEditBypass: false,
      delegatedTaskBypass: false,
    });
    expect(isBashApprovalBypassedForStream(STREAM_ID)).toBe(false);
    expect(host.emit).toHaveBeenNthCalledWith(3, 'updateSuperYoloBypassState', {
      streamId: STREAM_ID,
      bypassActive: false,
    });
    expect(host.emit).toHaveBeenNthCalledWith(
      4,
      'updateToolEditApprovalBypassState',
      {
        streamId: STREAM_ID,
        bypassActive: false,
      },
    );
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

  it('runs the pending tool-edit prompt lifecycle as one runtime session', () => {
    const host = createRecordingHost();
    applyRuntimeApprovalDecisionBypass({
      streamId: STREAM_ID,
      accepted: true,
      bypass: 'toolEdit',
      runtimeHost: host,
    });
    vi.mocked(host.emit).mockClear();
    let settled:
      | {
          readonly accepted: boolean;
        }
      | undefined;

    const session = startRuntimeToolEditApprovalPrompt({
      requestId: 'tool-edit-prompt',
      request: {
        path: 'proof.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'edit_file',
        streamId: STREAM_ID,
      },
      runtimeHost: host,
      pending: {
        streamId: STREAM_ID,
        runtimeHost: host,
        isSettled: () => settled !== undefined,
        settle: (result) => {
          settled = result;
        },
      },
    });
    session.emitPrompt({
      relativePath: 'proof.tex',
      lineChanges: { added: 2, removed: 1 },
    });

    expect(host.emit).toHaveBeenNthCalledWith(1, 'setActiveStream', {
      streamId: STREAM_ID,
    });
    expect(host.emit).toHaveBeenNthCalledWith(2, 'showToolEditPermission', {
      requestId: 'tool-edit-prompt',
      path: 'proof.tex',
      relativePath: 'proof.tex',
      sourceTool: 'edit_file',
      allowBypass: false,
      streamId: STREAM_ID,
      addedLines: 2,
      removedLines: 1,
      isLatex: true,
    });

    session.complete();

    expect(host.emit).toHaveBeenNthCalledWith(3, 'resolveToolEditPermission', {
      requestId: 'tool-edit-prompt',
    });

    cleanupApprovalsForStream(STREAM_ID);
    expect(settled).toBeUndefined();
  });
});
