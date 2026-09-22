import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import {
  generateSessionDescription,
  getDisplayedInstruction,
} from '@agent/runtime/sessionDescription';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { fakeStores } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { captureLogEntries } from '@test/support/logSinkCapture';
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
    ).pipe(
      // `helperModel` is mocked, but the program's type keeps the real
      // signature's `LanguageModel` requirement.
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
      Effect.provide(testHttpClientLayer),
      // The failure is reported with `Effect.logWarning`, so the host sink a
      // test captures is reached through the logger layer production installs.
      Effect.provide(effectDiagnosticsLayer('Trace')),
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
    setLogSink(null);
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

  it.effect(
    'uses the exact workflow-agent description carried by launch context',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        publishTestRunStart(session, 'a0b0c1' as RunId);
        yield* session.settlePublications();
        const recorded = recordSessionEvents(session);
        mockToolUseAnswer('Correcting derivation signs');

        yield* Effect.promise(() =>
          runDescription(
            'a0b0c1' as RunId,
            session,
            AgentCategory.Workflow,
            'Corrects a draft',
          ),
        );

        expect(mocks.helperCompletion.mock.calls[0]?.[1]).toEqual(
          expect.objectContaining({
            userPrompt: expect.stringContaining(
              '<agent-purpose>Corrects a draft</agent-purpose>',
            ),
          }),
        );
        expect(
          (yield* session.readView(['a0b0c1' as RunId])).runs.get(
            'a0b0c1' as RunId,
          )?.description,
        ).toBe('Correcting derivation signs');
        yield* session.settlePublications();
        expect(yield* Effect.promise(() => recorded.read())).toMatchObject([
          {
            type: 'run.description',
            aggregateId: qualifyAggregateId('run', 'a0b0c1' as RunId),
            description: 'Correcting derivation signs',
          },
        ]);
      }),
  );

  it.effect(
    'logs helper-model failures without rejecting the fire-and-forget call',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        const helperError = new Error('helper unavailable');
        const logs = captureLogEntries();
        mocks.helperModel.mockReturnValueOnce(Effect.fail(helperError));

        expect(
          yield* Effect.promise(() => runDescription(generateRunId(), session)),
        ).toBeUndefined();

        expect(logs.at('WARN', 'SessionDescription')).toHaveLength(1);
        expect(
          logs.has('WARN', 'SessionDescription', 'helper unavailable'),
        ).toBe(true);
      }),
  );
});
