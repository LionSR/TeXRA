// Regression coverage for issue #7086: `ToolUseProcessNode.post()` must emit
// the authoritative `response.finalized` fact exactly when a round both ends
// the turn AND actually streamed its output — never for non-streaming
// rounds (which already log their own MODEL_RESPONSE line in `exec()`) and
// never for a round that continues with tool calls.

import { describe, expect, it, vi } from 'vitest';

import { ToolUseProcessNode } from '@agent/core/flows/toolUseRound/ToolUseProcessNode';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import type { ToolUseRoundShared } from '@agent/core/flows/toolUseRound/roundShared';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { testModelCell } from '../modelCellTestUtils';

function buildServices(): ToolUseRoundServices<unknown> {
  return {
    run: { totalResponseTimeMs: 0, usageAccumulator: {}, totalRounds: 0 },
    workspace: {
      assembly: { lastResponse: '', accumulatedOutput: '' },
      serverToolContent: { contentBlocks: [], lastAssistantContent: [] },
      resetServerToolContent: vi.fn(),
      resetReasoning: vi.fn(),
    },
    onRoundFinalized: vi.fn(),
    modelCell: testModelCell({
      createAssistantMessageFromResponse: vi.fn(() => ({
        role: 'assistant',
        content: 'assistant message',
      })),
    }),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      responseFinalized: vi.fn(),
    },
  } as unknown as ToolUseRoundServices<unknown>;
}

function buildShared(): ToolUseRoundShared {
  return {
    messages: [],
    roundIndex: 0,
    roundResponseTimeMs: 0,
  } as unknown as ToolUseRoundShared;
}

function setup(): {
  services: ToolUseRoundServices<unknown>;
  node: ToolUseProcessNode<unknown>;
  shared: ToolUseRoundShared;
} {
  const services = buildServices();
  return {
    services,
    node: new ToolUseProcessNode().setServices(services),
    shared: buildShared(),
  };
}

describe('ToolUseProcessNode.post responseFinalized (#7086)', () => {
  it('emits responseFinalized with the authoritative text on a streamed, turn-ending round', async () => {
    const { services, node, shared } = setup();

    const transition = await node.post(
      shared,
      { shouldStop: false },
      {
        kind: 'success',
        endTurn: true,
        text: 'Done \\checkmark',
        useStreaming: true,
      },
    );

    expect(transition).toBe(FlowTransition.COMPLETE);
    expect(services.logger.responseFinalized).toHaveBeenCalledOnce();
    expect(services.logger.responseFinalized).toHaveBeenCalledWith(
      'Done \\checkmark',
    );
    expect(services.workspace.assembly.lastResponse).toBe('Done \\checkmark');
  });

  it('does not emit responseFinalized for a non-streaming round (exec() already logged it)', async () => {
    const { services, node, shared } = setup();

    await node.post(
      shared,
      { shouldStop: false },
      {
        kind: 'success',
        endTurn: true,
        text: 'The answer is 2.',
        useStreaming: false,
      },
    );

    expect(services.logger.responseFinalized).not.toHaveBeenCalled();
    expect(services.workspace.assembly.lastResponse).toBe('The answer is 2.');
  });

  it('does not emit responseFinalized for a round that continues with tool calls', async () => {
    const { services, node, shared } = setup();

    const transition = await node.post(
      shared,
      { shouldStop: false },
      {
        kind: 'success',
        endTurn: false,
        text: 'Let me check that.',
        useStreaming: true,
        toolCalls: [{} as never],
      },
    );

    expect(transition).toBe(FlowTransition.DEFAULT);
    expect(services.logger.responseFinalized).not.toHaveBeenCalled();
    // Non-final rounds never update `assembly.lastResponse` — only the round
    // that ends the turn does.
    expect(services.workspace.assembly.lastResponse).toBe('');
  });
});
