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
  type TurnResult,
} from '@texra-ai/llm';
import { googleInteractionsModel } from '../../../packages/llm/src/api/googleInteractions.js';

function model(
  store = true,
  background: 'supported' | 'unsupported' = 'unsupported',
) {
  return googleInteractionsModel(
    {
      protocol: 'google-interactions',
      requestedModel: 'gemini-test',
      background,
      deployment: {
        endpoint: 'https://synthetic.invalid',
        credentialScope: 'test-account',
      },
      defaults: { maxOutputTokens: 2048, store, thinkingLevel: 'high' },
    },
    { apiKey: 'synthetic-key' },
  );
}

function backgroundFixture() {
  return Effect.gen(function* () {
    const configured = model(true, 'supported');
    const turn = yield* configured.prepareTurn({
      ...request(),
      mode: 'background',
    });
    assert(
      turn.mode === 'background' && turn.protocol === 'google-interactions',
    );
    assert(configured.background);
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
    return { configured, turn, background: configured.background, operation };
  });
}

function request(): TurnRequest {
  return {
    system: 'Use both tools.',
    messages: [
      {
        role: 'user',
        content: [
          { kind: 'text', text: 'go' },
          { kind: 'text', text: 'Image: figures/panel.png' },
          {
            kind: 'image',
            mimeType: 'image/png',
            base64: 'AA==',
            detail: 'high',
          },
          { kind: 'text', text: 'Audio: sound.mp3' },
          { kind: 'audio', mimeType: 'audio/mp3', base64: 'TQ==' },
          { kind: 'text', text: 'Video: clip.mp4' },
          { kind: 'video', mimeType: 'video/mp4', base64: 'Vg==' },
          { kind: 'text', text: 'Document: paper.pdf' },
          { kind: 'document', mimeType: 'application/pdf', base64: 'UA==' },
          { kind: 'text', text: 'Document: empty.csv' },
          { kind: 'document', mimeType: 'text/csv', base64: '' },
        ],
      },
    ],
    tools: [
      {
        name: 'search',
        description: 'Search',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
      {
        name: 'fetch',
        description: 'Fetch',
        parameters: {
          type: 'object',
          properties: { u: { type: 'string' } },
          required: ['u'],
        },
      },
    ],
  };
}

function signedEvents(
  includeSummary = true,
  toolUseTokens?: number,
): Array<Record<string, unknown>> {
  return [
    {
      event_type: 'interaction.created',
      // The live opening event carries no status (gemini-3.8-flash, 2026-10).
      interaction: {
        id: 'int_1',
        object: 'interaction',
        model: 'gemini-returned',
      },
    },
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    ...(includeSummary
      ? [
          {
            event_type: 'step.delta',
            index: 0,
            delta: {
              type: 'thought_summary',
              content: { type: 'text', text: 'plan' },
            },
          },
        ]
      : []),
    {
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'thought_signature', signature: 'sig_b' },
    },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
    {
      event_type: 'step.delta',
      index: 1,
      delta: { type: 'text', text: 'thinking done' },
    },
    { event_type: 'step.stop', index: 1 },
    {
      event_type: 'step.start',
      index: 2,
      // gemini-3.8-flash signs the first call after its thought.
      step: {
        type: 'function_call',
        id: 'call_1',
        name: 'search',
        arguments: {},
        signature: 'sig_call',
      },
    },
    {
      event_type: 'step.delta',
      index: 2,
      delta: { type: 'arguments_delta', arguments: '{"q":' },
    },
    {
      event_type: 'step.delta',
      index: 2,
      delta: { type: 'arguments_delta', arguments: '"x"}' },
    },
    { event_type: 'step.stop', index: 2 },
    {
      event_type: 'step.start',
      index: 3,
      step: {
        type: 'function_call',
        id: 'call_2',
        name: 'fetch',
        arguments: {},
      },
    },
    {
      event_type: 'step.delta',
      index: 3,
      delta: { type: 'arguments_delta', arguments: '{"u":"y"}' },
    },
    { event_type: 'step.stop', index: 3 },
    {
      event_type: 'interaction.completed',
      interaction: {
        id: 'int_1',
        status: 'requires_action',
        usage: {
          total_input_tokens: 12,
          total_thought_tokens: 3,
          total_tool_use_tokens: toolUseTokens,
        },
      },
    },
  ];
}

function response(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function exchange(result: TurnResult): TurnRequest {
  assert(result.providerResponseId !== null);
  const initial = request();
  return {
    ...initial,
    continuation: result.continuation,
    messages: [
      ...initial.messages,
      {
        role: 'assistant',
        origin: result.requestedOrigin,
        content: result.content,
      },
      {
        role: 'tool',
        results: [
          {
            callOrdinal: 0,
            status: 'success',
            content: [
              { kind: 'text', text: 'a' },
              {
                kind: 'image',
                mimeType: 'image/png',
                base64: 'AQ==',
                detail: 'ultra-high',
              },
            ],
          },
          {
            callOrdinal: 1,
            status: 'success',
            content: [{ kind: 'text', text: 'b' }],
          },
        ],
      },
    ],
  };
}

// The Google SDK clones every request before handing it to `fetch`, and Node
// links a cloned Request's abort signal to its parent only weakly: once that
// dependent controller is collected the clone never sees the abort, so the
// signal reaching `fetch` is not a sound place to observe cancellation. The
// pre-clone signal the SDK derived from ours stays linked, so record it here
// and let the abort fixtures watch that one.
const preCloneSignal = new WeakMap<Request, AbortSignal>();
const cloneRequest = Request.prototype.clone;

describe('canonical Google Interactions protocol', () => {
  const fetchModel = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchModel
      .mockReset()
      .mockImplementation(async () => response(signedEvents()));
    vi.stubGlobal('fetch', fetchModel);
    Request.prototype.clone = function (this: Request) {
      const clone = cloneRequest.call(this);
      preCloneSignal.set(clone, this.signal);
      return clone;
    };
  });
  afterEach(() => {
    Request.prototype.clone = cloneRequest;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.effect(
    'submits once, polls signed tool calls, and replays their canonical results',
    () =>
      Effect.gen(function* () {
        const { configured, turn, background, operation } =
          yield* backgroundFixture();
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
        const replay = yield* configured.prepareTurn(
          exchange(completed.result),
        );
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
        expect(fetchModel).toHaveBeenCalledTimes(4);
      }),
  );
});
