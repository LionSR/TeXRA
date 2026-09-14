import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import {
  generateSessionDescription,
  getDisplayedInstruction,
} from '@agent/runtime/sessionDescription';
import * as logger from '@logger/logUtils';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { fakeStores } from '@test/support/FakePlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';

import { recordSessionEvents } from '../progressTestUtils';

const mocks = vi.hoisted(() => ({
  helperModel: vi.fn(),
  helperCompletion: vi.fn(),
}));

/**
 * The launching run's stores. `helperModel` is the only reader and it is
 * mocked here, so empty stores carry the description path.
 */
const STORES = fakeStores();

vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  helperModel: mocks.helperModel,
  helperCompletion: mocks.helperCompletion,
}));

/** A helper binding no test reads through; the completion is mocked. */
const BOUND = {} as BoundModel;

function runDescription(
  runId: RunId,
  session: ReturnType<typeof createTestSession>,
  category: AgentCategory = AgentCategory.ToolUse,
  agentDescription?: string,
): Promise<void> {
  return Effect.runPromise(
    generateSessionDescription(
      runId,
      AgentConfigSchema.parse({
        agent: category === AgentCategory.ToolUse ? 'chat' : 'correct',
        model: 'gemini35f',
        instruction: 'Fix grammar.',
        agentCategory: category,
      }),
      agentDescription,
      session,
      STORES,
    ),
  );
}

/** Point the helper model at one resolved answer. */
function mockToolUseAnswer(text: string): void {
  mocks.helperModel.mockReturnValue(Effect.succeed(BOUND));
  mocks.helperCompletion.mockReturnValue(Effect.succeed(text));
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
    mockToolUseAnswer('Correcting derivation signs');

    await runDescription(
      'a0b0c1' as RunId,
      session,
      AgentCategory.Workflow,
      'Corrects a draft',
    );

    expect(mocks.helperCompletion.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        userPrompt: expect.stringContaining(
          '<agent-purpose>Corrects a draft</agent-purpose>',
        ),
      }),
    );
    expect(
      (await Effect.runPromise(session.readView(['a0b0c1' as RunId]))).runs.get(
        'a0b0c1' as RunId,
      )?.description,
    ).toBe('Correcting derivation signs');
    await session.settlePublications();
    expect(await recorded.read()).toMatchObject([
      {
        type: 'run.description',
        aggregateId: qualifyAggregateId('run', 'a0b0c1' as RunId),
        description: 'Correcting derivation signs',
      },
    ]);
  });

  it('logs helper-model failures without rejecting the fire-and-forget call', async () => {
    const session = createTestSession();
    const helperError = new Error('helper unavailable');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mocks.helperModel.mockReturnValueOnce(Effect.fail(helperError));

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
