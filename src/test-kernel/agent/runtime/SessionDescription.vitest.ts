import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRunRecords } from '@agent/storage';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  generateSessionDescription,
  getDisplayedInstruction,
} from '@agent/runtime/sessionDescription';
import * as logger from '@logger/logUtils';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';

import { recordSessionEvents } from '../progressTestUtils';

const mocks = vi.hoisted(() => ({
  createHelperModelKit: vi.fn(),
}));

vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  createHelperModelKit: mocks.createHelperModelKit,
}));

function runDescription(
  runId: RunId,
  session: ReturnType<typeof createTestSession>,
  category: AgentCategory = AgentCategory.ToolUse,
  agentDescription?: string,
): Promise<void> {
  return generateSessionDescription(
    runId,
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

  it('uses the exact workflow-agent description carried by launch context', async () => {
    const session = createTestSession();
    publishTestRunStart(session, 'a0b0c1' as RunId);
    await session.settlePublications();
    const recorded = recordSessionEvents(session);
    const handler = mockToolUseAnswer('Correcting derivation signs');

    await runDescription(
      'a0b0c1' as RunId,
      session,
      AgentCategory.Workflow,
      'Corrects a draft',
    );

    expect(handler.initializeMessages.mock.calls[0]?.[1]).toContain(
      '<agent-purpose>Corrects a draft</agent-purpose>',
    );
    expect(
      (
        await Effect.runPromise(
          getRunRecords(session, 'a0b0c1' as RunId).readMeta(),
        )
      )?.description,
    ).toBe('Correcting derivation signs');
    await session.settlePublications();
    expect(await recorded.read()).toMatchObject([
      {
        type: 'updateRunDescription',
        aggregateId: qualifyAggregateId('run', 'a0b0c1' as RunId),
        description: 'Correcting derivation signs',
      },
    ]);
  });

  it('logs helper-model failures without rejecting the fire-and-forget call', async () => {
    const session = createTestSession();
    const helperError = new Error('helper unavailable');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mocks.createHelperModelKit.mockRejectedValueOnce(helperError);

    await expect(
      runDescription(generateRunId(), session),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'SessionDescription',
      expect.stringContaining('helper unavailable'),
    );
  });
});
