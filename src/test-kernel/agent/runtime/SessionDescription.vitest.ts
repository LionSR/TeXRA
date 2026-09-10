import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';
import { getRunRecords } from '@agent/storage';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  generateSessionDescription,
  getDisplayedInstruction,
} from '@agent/runtime/sessionDescription';
import * as logger from '@logger/logUtils';
import {
  aggregateId as qualifyAggregateId,
  type RunId,
  type StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

import { recordSessionEvents } from '../progressTestUtils';

const mocks = vi.hoisted(() => ({
  createHelperModelKit: vi.fn(),
}));

vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  createHelperModelKit: mocks.createHelperModelKit,
}));

function runDescription(
  executionId: string,
  streamId: string,
  session: ReturnType<typeof createTestSession>,
  category: AgentCategory = AgentCategory.ToolUse,
  agentDescription?: string,
): Promise<void> {
  return generateSessionDescription(
    executionId as RunId,
    streamId as StreamTabId,
    AgentConfigSchema.parse({
      agent: category === AgentCategory.ToolUse ? 'chat' : 'correct',
      model: 'gemini35f',
      instruction: 'Fix grammar.',
      agentCategory: category,
    }),
    agentDescription,
    session,
  );
}

/** A helper model that answers with `text`. */
function helperAnswering(text: string) {
  return {
    createResponse: vi.fn().mockResolvedValue({ response: {} }),
    extractResponse: vi.fn().mockReturnValue({ text }),
    initializeMessages: vi.fn().mockResolvedValue([]),
  };
}

/** Point the helper-model kit at one resolved answer. */
function mockToolUseAnswer(text: string): ReturnType<typeof helperAnswering> {
  const handler = helperAnswering(text);
  mocks.createHelperModelKit.mockResolvedValue({
    kit: { client: {}, handler },
  });
  return handler;
}

describe('session description helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('prefers displayInstruction over hidden prompt context', () => {
    expect(
      getDisplayedInstruction({
        displayInstruction: 'Assess the proof concisely.',
        instruction:
          'Primary user input files:\n- "problem.md"\n\nAdditional user instruction:\n\nAssess the proof concisely.',
      }),
    ).toBe('Assess the proof concisely.');
  });

  it('falls back to instruction when displayInstruction is blank', () => {
    expect(
      getDisplayedInstruction({
        displayInstruction: '   ',
        instruction: 'Summarize the paper.',
      }),
    ).toBe('Summarize the paper.');
  });

  it.live(
    'uses the exact workflow-agent description carried by launch context',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        publishTestRunStart(
          session,
          'stream-workflow',
          'a0b0c1' as RunId,
        );
        yield* Effect.promise(() => session.settlePublications());
        const recorded = recordSessionEvents(session);
        const handler = mockToolUseAnswer('Correcting derivation signs');

        yield* Effect.promise(() =>
          runDescription(
            'a0b0c1',
            'stream-workflow',
            session,
            AgentCategory.Workflow,
            'Corrects a draft',
          ),
        );

        expect(handler.initializeMessages.mock.calls[0]?.[1]).toContain(
          '<agent-purpose>Corrects a draft</agent-purpose>',
        );
        expect(
          (yield* getRunRecords(session, 'a0b0c1').readMeta())
            ?.description,
        ).toBe('Correcting derivation signs');
        yield* Effect.promise(() => session.settlePublications());
        expect(yield* Effect.promise(() => recorded.read())).toMatchObject([
          {
            type: 'updateStreamDescription',
            aggregateId: qualifyAggregateId('stream', 'stream-workflow'),
            description: 'Correcting derivation signs',
          },
        ]);
      }),
  );

  it('logs helper-model failures without rejecting the fire-and-forget call', async () => {
    const session = createTestSession();
    const helperError = new Error('helper unavailable');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mocks.createHelperModelKit.mockRejectedValueOnce(helperError);

    await expect(
      runDescription('exec-failure', 'stream-failure', session),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'SessionDescription',
      expect.stringContaining('helper unavailable'),
    );
  });

  it('does not reject when the diagnostic sink also fails', async () => {
    const session = createTestSession();
    mocks.createHelperModelKit.mockRejectedValueOnce(
      new Error('helper unavailable'),
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('log sink unavailable');
    });

    await expect(
      runDescription('exec-log-failure', 'stream-log-failure', session),
    ).resolves.toBeUndefined();
  });

  it.live('keeps generating compact descriptions for tool-use runs', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      publishTestRunStart(session, 'stream-tool', 'a0b0c2' as RunId);
      yield* Effect.promise(() => session.settlePublications());
      const recorded = recordSessionEvents(session);
      mockToolUseAnswer('Fixing proof typos');

      yield* Effect.promise(() =>
        runDescription('a0b0c2', 'stream-tool', session),
      );

      expect(
        (yield* getRunRecords(session, 'a0b0c2').readMeta())?.description,
      ).toBe('Fixing proof typos');
      yield* Effect.promise(() => session.settlePublications());
      expect(yield* Effect.promise(() => recorded.read())).toMatchObject([
        {
          type: 'updateStreamDescription',
          aggregateId: qualifyAggregateId('stream', 'stream-tool'),
          description: 'Fixing proof typos',
        },
      ]);
    }),
  );
});
