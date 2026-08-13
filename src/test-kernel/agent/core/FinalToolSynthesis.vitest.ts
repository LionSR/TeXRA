import { describe, expect, it, vi } from 'vitest';

import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import { createToolUseRoundFlow } from '@agent/core/flows/ToolUseRoundFlow';
import type { ToolUseRoundShared } from '@agent/core/flows/toolUseRound/roundShared';
import type { CreateResponseOptions } from '@agent/types/ModelHandlerContracts';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { withTestRunContext } from '../progressTestUtils';
import { baseRoundServices, roundModelHandler } from '../toolUseRoundTestUtils';
import { testModelCell } from '../modelCellTestUtils';

function buildRound(supportsForcedToolChoice: boolean) {
  const requests: CreateResponseOptions[] = [];
  const createResponse = vi.fn(async (options: CreateResponseOptions) => {
    requests.push(options);
    return { response: { turn: requests.length } };
  });
  const services = {
    ...baseRoundServices('FinalToolSynthesis', 'final-tool-synthesis'),
    finalTool: { name: 'submit_output' },
    modelCell: testModelCell(
      roundModelHandler({
        createAssistantMessageFromResponse: vi.fn(
          (_response: unknown, text: string) =>
            ({ role: 'assistant', content: text }) as ProviderMessage,
        ),
        createResponse,
        createUserFollowUpMessages: vi.fn(
          async (messages: ProviderMessage[], text: string) => [
            ...messages,
            { role: 'user', content: text } as ProviderMessage,
          ],
        ),
        extractResponse: (response: { turn: number }) => ({
          text: response.turn === 1 ? 'Draft answer' : '',
          usage: null,
          stopReason: 'stop',
        }),
        isEndTurnStop: () => true,
        supportsForcedToolChoice,
      }),
    ),
    session: { hasQueuedFollowUp: () => false },
    setting: {
      temperature: 0,
      tools: [{ name: 'submit_output', description: 'Submit output' }],
    },
  } as unknown as ToolUseRoundServices;
  const shared: ToolUseRoundShared = {
    messages: [{ role: 'user', content: 'Research this' }],
    shouldStop: false,
    endTurn: false,
    roundIndex: 0,
    roundResponseTimeMs: 0,
  };

  return { requests, services, shared };
}

const EXPECTED_MESSAGES = [
  { role: 'user', content: 'Research this' },
  { role: 'assistant', content: 'Draft answer' },
  { role: 'user', content: 'Submit the final structured output now.' },
];

describe('final-tool synthesis turn', () => {
  it.each([
    {
      title: 'keeps exploration unforced, then forces exactly one final turn',
      supportsForcedToolChoice: true,
      expectedFinalTools: [undefined, { name: 'submit_output' }],
    },
    {
      title: 'asks once without forcing when the provider cannot force tools',
      supportsForcedToolChoice: false,
      expectedFinalTools: [undefined, undefined],
    },
  ])('$title', async ({ supportsForcedToolChoice, expectedFinalTools }) => {
    const { requests, services, shared } = buildRound(supportsForcedToolChoice);

    await withTestRunContext(services.runScope, () =>
      createToolUseRoundFlow().setServices(services).run(shared),
    );

    expect(requests.map((request) => request.finalTool)).toEqual(
      expectedFinalTools,
    );
    if (supportsForcedToolChoice) {
      expect(shared.finalTool).toBeUndefined();
    }
    expect(shared.finalToolAttempted).toBe(true);
    expect(shared.messages).toEqual(EXPECTED_MESSAGES);
  });
});
