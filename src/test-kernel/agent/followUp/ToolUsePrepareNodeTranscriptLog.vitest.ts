// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentPromptSchema } from '@agent/core/definition/AgentDataclass';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ToolUsePrepareNode } from '@agent/implementations/flows/tooluse/nodes/ToolUsePrepareNode';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';

function buildServices(
  overrides: Partial<ToolUseServices<unknown>> = {},
): ToolUseServices<unknown> {
  return {
    config: AgentConfigSchema.parse({ agent: 'chat', model: 'deepseekT' }),
    fileService: {} as never,
    isSubagent: false,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    modelHandler: {
      consumeInsertedAttachmentKinds: vi.fn(() => []),
      initializeMessages: vi.fn(async () => []),
    } as never,
    onRoundFinalized: vi.fn(),
    prompt: AgentPromptSchema.parse({
      systemPrompt: 'You are careful.',
      userRequest: 'Do the thing.',
    }),
    resolvedTools: [],
    session: {} as never,
    setting: { agentCategory: 'toolUse' } as never,
    snapshot: null,
    streamStatus: {} as never,
    toolRegistry: {} as never,
    userVarChannels: { input: {}, transient: {} },
    checkInterruption: () => false,
    setAbortController: () => {},
    ...overrides,
  } as ToolUseServices<unknown>;
}

describe('ToolUsePrepareNode transcript logging (regression #7508)', () => {
  it('logs the initial transcript row when initializeMessages throws', async () => {
    // A failed first turn (corrupt/oversized media, provider validation
    // error, ...) must still leave a record of what the user asked for —
    // otherwise the transcript's opening row silently vanishes for exactly
    // the runs most likely to need debugging.
    const services = buildServices({
      initialUserMessageForTranscript: 'Do the thing.',
    });
    (
      services.modelHandler.initializeMessages as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('media processing failed'));
    const node = new ToolUsePrepareNode().setServices(services);

    await expect(node.exec(undefined)).rejects.toThrow(
      'media processing failed',
    );

    expect(services.logger.info).toHaveBeenCalledWith(
      'Do the thing.',
      expect.objectContaining({ messageType: expect.any(String) }),
    );
    expect(
      services.modelHandler.consumeInsertedAttachmentKinds,
    ).toHaveBeenCalledWith('initial');
  });

  it('still logs exactly once on the success path', async () => {
    const services = buildServices({
      initialUserMessageForTranscript: 'Do the thing.',
    });
    const node = new ToolUsePrepareNode().setServices(services);

    await node.exec(undefined);

    expect(services.logger.info).toHaveBeenCalledTimes(1);
  });

  it('does not log when there is no initial transcript row to write', async () => {
    const services = buildServices({
      initialUserMessageForTranscript: undefined,
    });
    services.modelHandler.initializeMessages = vi
      .fn()
      .mockRejectedValue(new Error('boom')) as never;
    const node = new ToolUsePrepareNode().setServices(services);

    await expect(node.exec(undefined)).rejects.toThrow('boom');

    expect(services.logger.info).not.toHaveBeenCalled();
  });
});

function buildSnapshot(
  overrides: Partial<ToolUseSessionSnapshot> = {},
): ToolUseSessionSnapshot {
  return {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'stale system' }] },
    ],
    run: AgentRunStateSnapshotSchema.parse({}),
    workspace: AgentWorkspaceState.create().toSnapshot(),
    user: { input: {}, transient: {} },
    ...overrides,
  } as ToolUseSessionSnapshot;
}

describe('ToolUsePrepareNode resume (system message refresh delegation)', () => {
  it('delegates the persisted system message rebuild to the model handler port, not a local re-derivation', async () => {
    // The node must hand the stale persisted messages and the freshly
    // rebuilt system text straight to the model handler and use whatever
    // comes back — it has no business knowing provider message shape.
    const refreshedMessages = [
      { role: 'system', content: [{ type: 'text', text: 'refreshed' }] },
    ];
    const refreshSystemMessage = vi.fn(() => refreshedMessages);
    const snapshot = buildSnapshot();
    const services = buildServices({
      snapshot,
      modelHandler: {
        consumeInsertedAttachmentKinds: vi.fn(() => []),
        initializeMessages: vi.fn(async () => []),
        refreshSystemMessage,
      } as never,
    });
    const node = new ToolUsePrepareNode().setServices(services);

    const result = await node.exec(undefined);

    expect(refreshSystemMessage).toHaveBeenCalledWith(
      snapshot.messages,
      expect.stringMatching(/^You are careful\.\n/),
    );
    expect(result.result.messages).toBe(refreshedMessages);
    expect(result.result.shouldSkipCycle).toBe(true);
    // initializeMessages is the fresh-session path; resume must not call it.
    expect(services.modelHandler.initializeMessages).not.toHaveBeenCalled();
  });
});
