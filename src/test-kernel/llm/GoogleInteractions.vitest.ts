// Node imports
import assert from 'node:assert/strict';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, Schema, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import {
  completedTurn,
  RemoteOperationSchema,
  type TurnRequest,
} from '@texra-ai/llm';
import { googleInteractionsModel } from '../../../packages/llm/src/api/googleInteractions.js';

const REQUEST: TurnRequest = {
  system: 'Use both tools.',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
  tools: ['search', 'fetch'].map((name) => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
  })),
};

function response(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

describe('canonical Google Interactions protocol', () => {
  const fetchModel = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchModel.mockReset().mockImplementation(async () =>
      response([
        {
          event_type: 'interaction.created',
          interaction: { id: 'int_2', object: 'interaction' },
        },
        {
          event_type: 'interaction.completed',
          interaction: { id: 'int_2', status: 'completed' },
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchModel);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect(
    'submits once, polls signed tool calls, and replays their canonical results',
    () =>
      Effect.gen(function* () {
        const configured = googleInteractionsModel(
          {
            protocol: 'google-interactions',
            requestedModel: 'gemini-test',
            background: 'supported',
            deployment: {
              endpoint: 'https://synthetic.invalid',
              credentialScope: 'test-account',
            },
            defaults: {
              maxOutputTokens: 2048,
              store: true,
              thinkingLevel: 'high',
            },
          },
          { apiKey: 'synthetic-key' },
        );
        const turn = yield* configured.prepareTurn({
          ...REQUEST,
          mode: 'background',
        });
        assert(
          turn.mode === 'background' && turn.protocol === 'google-interactions',
        );
        const background = configured.background;
        assert(background);
        const operation = Schema.decodeUnknownSync(RemoteOperationSchema)({
          origin: {
            protocol: turn.protocol,
            codecVersion: turn.codecVersion,
            requestedModel: turn.requestedModel,
            deployment: turn.deployment,
          },
          providerResponseId: 'int_1',
          afterSequence: null,
        });
        fetchModel.mockImplementationOnce(async () =>
          Response.json({
            id: 'int_1',
            status: 'queued',
            model: 'gemini-returned',
          }),
        );
        expect(yield* background.submit(turn)).toEqual({
          kind: 'accepted',
          operation,
          returnedModel: 'gemini-returned',
        });
        expect(
          yield* Effect.promise(() =>
            (fetchModel.mock.calls[0][0] as Request).json(),
          ),
        ).toMatchObject({ background: true, stream: false, store: true });
        fetchModel.mockImplementationOnce(async () =>
          Response.json({
            id: 'int_1',
            status: 'in_progress',
            model: 'gemini-returned',
          }),
        );
        fetchModel.mockImplementationOnce(async () =>
          Response.json({
            id: 'int_1',
            status: 'requires_action',
            steps: [
              // A GET echoes the interaction's input, include_input or not.
              {
                type: 'user_input',
                content: [{ type: 'text', text: 'go' }],
              },
              {
                type: 'thought',
                summary: [{ type: 'text', text: 'plan' }],
                signature: 'sig_b',
              },
              {
                type: 'model_output',
                content: [{ type: 'text', text: 'thinking done' }],
              },
              {
                type: 'function_call',
                id: 'call_1',
                name: 'search',
                arguments: { q: 'one' },
                signature: 'sig_call',
              },
              {
                type: 'function_call',
                id: 'call_2',
                name: 'fetch',
                arguments: { u: 'two' },
              },
            ],
            usage: {
              total_input_tokens: 12,
              total_output_tokens: 8,
              total_tokens: 20,
              total_cached_tokens: 3,
              total_thought_tokens: 2,
              total_tool_use_tokens: 5,
            },
          }),
        );
        const observation = yield* Stream.runCollect(
          background.observe(turn, operation, { deadlineAtMs: 10_000 }),
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust('5 seconds');
        const events = yield* Fiber.join(observation);
        expect(
          events.map((event) => [event.kind, event.afterSequence]),
        ).toEqual([
          ['identified', null],
          ['completed', null],
        ]);
        const completed = events.at(-1);
        assert(completed?.kind === 'completed');
        expect(completed.result).toMatchObject({
          providerResponseId: 'int_1',
          returnedModel: 'gemini-returned',
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
            cachedInputTokens: 3,
            reasoningTokens: 2,
            providerUsage: { kind: 'google', toolUsePromptTokens: 5 },
          },
        });
        expect(completed.result.continuation).toMatchObject({
          coveredMessages: 2,
          anchor: { interactionId: 'int_1', coveredSteps: 5 },
        });
        const replay = yield* configured.prepareTurn({
          ...REQUEST,
          continuation: completed.result.continuation,
          messages: [
            ...REQUEST.messages,
            {
              role: 'assistant',
              origin: completed.result.requestedOrigin,
              content: completed.result.content,
            },
            {
              role: 'tool',
              results: [0, 1].map((callOrdinal) => ({
                callOrdinal,
                status: 'success' as const,
                content: [{ kind: 'text' as const, text: 'ok' }],
              })),
            },
          ],
        });
        assert(replay.mode === 'foreground');
        yield* completedTurn(configured.streamTurn(replay));
        // The observed turn anchors the next round: its steps are the ones
        // the interaction already holds, so the replay sends only what
        // follows them.
        expect(
          yield* Effect.promise(() =>
            (fetchModel.mock.calls[3][0] as Request).json(),
          ),
        ).toMatchObject({
          background: false,
          stream: true,
          previous_interaction_id: 'int_1',
          input: [
            { type: 'function_result', call_id: 'call_1' },
            { type: 'function_result', call_id: 'call_2' },
          ],
        });
        expect(
          fetchModel.mock.calls
            .slice(1, 3)
            .every(([url]) =>
              (url as Request).url.includes('include_input=false'),
            ),
        ).toBe(true);
      }),
  );
});
