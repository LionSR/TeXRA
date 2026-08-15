import { describe, expect, it, vi } from 'vitest';

import { ToolUseRoundPrepNode } from '@agent/implementations/flows/tooluse/toolUseRound/ToolUseRoundPrepNode';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import type { ToolUseRoundShared } from '@agent/implementations/flows/tooluse/toolUseRound/roundShared';
import { testRunScope, withTestRunContext } from '../progressTestUtils';
import { testModelCell } from '../modelCellTestUtils';

function buildServices(
  overrides: Partial<ToolUseRoundServices<unknown>> = {},
): ToolUseRoundServices<unknown> {
  return {
    runScope: testRunScope('test-stream'),
    config: { model: 'deepseekT', agent: 'chat' } as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onRoundFinalized: () => {},
    modelCell: testModelCell({
      createUserFollowUpMessages: vi.fn(async (messages) => messages),
      addMediaToUserMessage: vi.fn(async () => []),
      capabilities: {},
    }) as never,
    fileService: { createLocation: vi.fn() } as never,
    toolRegistry: {} as never,
    ...overrides,
  } as ToolUseRoundServices<unknown>;
}

function buildShared(): ToolUseRoundShared {
  return {
    messages: [],
    shouldStop: false,
    endTurn: false,
  } as unknown as ToolUseRoundShared;
}

describe('ToolUseRoundPrepNode follow-up transcript logging (regression: #7508 pattern on a round)', () => {
  function rejectFollowUpAppend(
    services: ToolUseRoundServices<unknown>,
    message: string,
  ): void {
    (
      services.modelCell.handler.createUserFollowUpMessages as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(new Error(message));
  }

  it('logs a follow-up transcript row even when appendFollowUpAsUserMessage throws', async () => {
    // A failed follow-up append mid-round (corrupt/oversized media, provider
    // validation error, ...) must still leave a record of what the user
    // asked for — otherwise that turn's transcript row silently vanishes.
    const services = buildServices();
    rejectFollowUpAppend(services, 'follow-up append failed');
    const node = new ToolUseRoundPrepNode().setServices(services);
    const shared = buildShared();

    await expect(
      withTestRunContext(services.runScope, () =>
        node.post(shared, {
          interrupted: false,
          queuedFollowUps: [{ text: 'Do the thing.', origin: 'user' }],
          synthetic: false,
        }),
      ),
    ).rejects.toThrow('follow-up append failed');

    expect(services.logger.info).toHaveBeenCalledWith(
      'Do the thing.',
      expect.objectContaining({ messageType: expect.any(String) }),
    );
  });

  it('logs each follow-up and refreshes the instruction from user input', async () => {
    const services = buildServices();
    const node = new ToolUseRoundPrepNode().setServices(services);
    const shared = {
      ...buildShared(),
      currentUserInstruction: 'initial request',
    };
    const transition = await withTestRunContext(services.runScope, () =>
      node.post(shared, {
        interrupted: false,
        queuedFollowUps: [
          { text: 'Do the thing.', origin: 'user' },
          {
            text: '<subagent-result>done</subagent-result>',
            origin: 'subagent_result',
          },
        ],
        synthetic: false,
      }),
    );

    expect(transition).toBeDefined();
    expect(services.logger.info).toHaveBeenCalledTimes(2);
    expect(shared.currentUserInstruction).toBe('Do the thing.');
  });

  it('does not log synthetic follow-ups', async () => {
    const services = buildServices();
    rejectFollowUpAppend(services, 'boom');
    const node = new ToolUseRoundPrepNode().setServices(services);
    const shared = buildShared();

    await expect(
      withTestRunContext(services.runScope, () =>
        node.post(shared, {
          interrupted: false,
          queuedFollowUps: [{ text: 'synthesized', origin: 'user' }],
          synthetic: true,
        }),
      ),
    ).rejects.toThrow('boom');

    expect(services.logger.info).not.toHaveBeenCalled();
  });
});
