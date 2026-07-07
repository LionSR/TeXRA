// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentPromptSchema } from '@agent/core/definition/AgentDataclass';
import { ToolUsePrepareNode } from '@agent/implementations/flows/tooluse/nodes/ToolUsePrepareNode';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';

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
