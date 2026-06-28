import { describe, expect, it, vi } from 'vitest';

import {
  AgentExecutionHandle,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import {
  getRuntimeModelSwitchState,
  requestRuntimeModelSwitch,
} from '@agent/runtime/modelSwitch';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

function createToolUseFlowContext(
  overrides: Partial<LiveToolUseFlowContext> = {},
): LiveToolUseFlowContext {
  return {
    session: {
      appendFollowUp: vi.fn(),
    },
    modelHandler: {
      supportsManualCompaction: true,
    },
    requestImmediateCompaction: vi.fn(),
    modelSwitchDisabledReason: vi.fn(),
    switchModel: vi.fn(),
    ...overrides,
  };
}

describe('runtime model-switch commands', () => {
  it('reports no target when the stream has no live tool-use flow', async () => {
    const session = new SessionHandle();
    const streamId = 'model-switch-no-flow' as StreamTabId;

    try {
      expect(
        getRuntimeModelSwitchState({
          streamId,
          candidateModel: 'blocked-model',
          session,
        }),
      ).toEqual({ status: 'no_target' });
      await expect(
        requestRuntimeModelSwitch({
          streamId,
          model: 'next-model',
          session,
        }),
      ).resolves.toEqual({ status: 'no_target' });
    } finally {
      session.dispose();
    }
  });

  it('delegates disabled reasons and switch requests to the live flow', async () => {
    const session = new SessionHandle();
    const streamId = 'model-switch-live-flow' as StreamTabId;
    const host = createRecordingHost();
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const modelSwitchDisabledReason = vi.fn((candidate: string) =>
      candidate === 'blocked-model' ? 'Provider format differs.' : undefined,
    );
    const context = createToolUseFlowContext({
      runtimeHost: host,
      modelSwitchDisabledReason,
      switchModel,
    });

    try {
      const handle = new AgentExecutionHandle(
        'exec-model-switch-live-flow',
        streamId,
        streamId,
        'test-tool-use',
        'toolUse',
        host,
      );
      handle.attachToolUseFlow(context);
      session.executions.track(handle);

      expect(
        getRuntimeModelSwitchState({
          streamId,
          candidateModel: 'blocked-model',
          session,
        }),
      ).toEqual({
        status: 'target',
        disabledReason: 'Provider format differs.',
      });

      await expect(
        requestRuntimeModelSwitch({
          streamId,
          model: 'next-model',
          session,
        }),
      ).resolves.toEqual({ status: 'switched' });

      expect(modelSwitchDisabledReason).toHaveBeenCalledWith('blocked-model');
      expect(modelSwitchDisabledReason).toHaveBeenCalledWith('next-model');
      expect(switchModel).toHaveBeenCalledWith('next-model');
    } finally {
      session.dispose();
    }
  });

  it('does not switch to a candidate rejected by the live flow', async () => {
    const session = new SessionHandle();
    const streamId = 'model-switch-disabled' as StreamTabId;
    const host = createRecordingHost();
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const modelSwitchDisabledReason = vi.fn((candidate: string) =>
      candidate === 'blocked-model' ? 'Provider format differs.' : undefined,
    );
    const context = createToolUseFlowContext({
      runtimeHost: host,
      modelSwitchDisabledReason,
      switchModel,
    });

    try {
      const handle = new AgentExecutionHandle(
        'exec-model-switch-disabled',
        streamId,
        streamId,
        'test-tool-use',
        'toolUse',
        host,
      );
      handle.attachToolUseFlow(context);
      session.executions.track(handle);

      await expect(
        requestRuntimeModelSwitch({
          streamId,
          model: 'blocked-model',
          session,
        }),
      ).resolves.toEqual({
        status: 'disabled',
        reason: 'Provider format differs.',
      });

      expect(switchModel).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });
});
