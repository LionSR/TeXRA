// Node imports
import assert from 'node:assert/strict';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import {
  assistantMessageFromResult,
  completedTurn,
  type TurnRequest,
} from '@texra-ai/llm';
import { anthropicMessagesModel } from '../../../packages/llm/src/api/anthropicMessages.js';
import type { AnthropicMessagesConfiguration } from '../../../packages/llm/src/turn.js';

const CONFIG: AnthropicMessagesConfiguration = {
  protocol: 'anthropic-messages',
  requestedModel: 'selected-claude',
  deployment: {
    endpoint: 'https://synthetic.invalid',
    credentialScope: 'account-a',
  },
  supportsSystemMessages: false,
  defaults: {
    maxOutputTokens: 8192,
    thinking: { mode: 'adaptive', display: 'summarized' },
    effort: 'high',
    cache: '5m',
    stopSequences: [],
  },
};
const REQUEST: TurnRequest = {
  system: 'Exact system\n',
  messages: [
    {
      role: 'user',
      content: [{ kind: 'text', text: 'Read these exact bytes.' }],
    },
  ],
  tools: ['search', 'fetch'].map((name) => ({
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
  })),
};

function initial() {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'returned-claude',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_creation: {
          ephemeral_5m_input_tokens: 11,
          ephemeral_1h_input_tokens: 19,
        },
      },
    },
  };
}
function terminal(reason = 'end_turn') {
  return [
    {
      type: 'message_delta',
      delta: {
        stop_reason: reason,
        stop_sequence: null,
        stop_details: null,
      },
      usage: {
        input_tokens: 12,
        output_tokens: 11,
        output_tokens_details: { thinking_tokens: 6 },
      },
    },
    { type: 'message_stop' },
  ];
}
function signedEvents(): Array<Record<string, unknown>> {
  return [
    initial(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '  returned thinking\n' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signature-a' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'signature-empty' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'redacted_thinking', data: 'opaque-redacted' },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'text_delta', text: '  calling tools\n' },
    },
    { type: 'content_block_stop', index: 3 },
    ...['search', 'fetch'].flatMap((name, ordinal) => [
      {
        type: 'content_block_start',
        index: ordinal + 4,
        content_block: {
          type: 'tool_use',
          id: `call_${ordinal}`,
          name,
          input: {},
          caller: { type: 'direct' },
        },
      },
      {
        type: 'content_block_delta',
        index: ordinal + 4,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      },
      {
        type: 'content_block_delta',
        index: ordinal + 4,
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      },
      { type: 'content_block_stop', index: ordinal + 4 },
    ]),
    ...terminal('tool_use'),
  ];
}
function response(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

describe('canonical Anthropic Messages protocol', () => {
  const fetchModel = vi.fn<typeof fetch>();
  const model = () =>
    anthropicMessagesModel(CONFIG, {
      apiKey: 'selected-key',
      fetch: fetchModel,
    });
  /** The JSON body the model sent on fetch call `index`. */
  const sentBody = (index: number) => {
    const body = fetchModel.mock.calls[index][1]?.body;
    if (typeof body !== 'string') {
      throw new Error(`fetch call ${index} sent no JSON text`);
    }
    return JSON.parse(body);
  };
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', '');
    fetchModel.mockReset();
    fetchModel.mockImplementation(async () => response(signedEvents()));
  });
  afterEach(() => vi.unstubAllEnvs());

  it.effect(
    'round-trips signed and redacted blocks with two ordered local settlements and exact materialized media',
    () =>
      Effect.gen(function* () {
        vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-bearer');
        vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.invalid');
        const configured = model();
        const prepared = yield* configured.prepareTurn(REQUEST);
        assert(prepared.mode === 'foreground');
        const events = yield* Stream.runCollect(
          configured.streamTurn(prepared),
        );
        expect(events[0]).toMatchObject({
          kind: 'identified',
          providerResponseId: 'msg_1',
          returnedModel: 'returned-claude',
        });
        expect(
          events.flatMap((event) =>
            event.kind === 'delta' ? [[event.part, event.text]] : [],
          ),
        ).toEqual([
          ['reasoning', '  returned thinking\n'],
          ['text', '  calling tools\n'],
        ]);
        const completed = events.at(-1);
        assert(completed?.kind === 'completed');
        const result = completed.result;
        expect(result.content).toEqual([
          {
            kind: 'reasoning',
            summary: [],
            content: [{ kind: 'text', text: '  returned thinking\n' }],
            evidence: {
              kind: 'anthropic-thinking-signature',
              signature: 'signature-a',
            },
          },
          {
            kind: 'reasoning',
            summary: [],
            content: [{ kind: 'text', text: '' }],
            evidence: {
              kind: 'anthropic-thinking-signature',
              signature: 'signature-empty',
            },
          },
          {
            kind: 'reasoning',
            summary: [],
            evidence: {
              kind: 'anthropic-redacted-thinking',
              data: 'opaque-redacted',
            },
          },
          {
            kind: 'message',
            content: [{ kind: 'text', text: '  calling tools\n' }],
          },
          {
            kind: 'local-call',
            providerCallId: 'call_0',
            name: 'search',
            // The exact concatenation of both input_json_delta fragments.
            argumentsText: '{"q":"x"}',
          },
          {
            kind: 'local-call',
            providerCallId: 'call_1',
            name: 'fetch',
            argumentsText: '{"q":"x"}',
          },
        ]);
        expect(result.usage).toEqual({
          inputTokens: 62,
          outputTokens: 11,
          totalTokens: 73,
          cachedInputTokens: 20,
          cacheWriteTokens: 30,
          reasoningTokens: 6,
          toolUsePromptTokens: null,
          providerUsage: {
            kind: 'anthropic',
            uncachedInputTokens: 12,
            cacheCreation5mTokens: 11,
            cacheCreation1hTokens: 19,
          },
        });
        const first = sentBody(0);
        const headers = new Headers(fetchModel.mock.calls[0][1]?.headers);
        expect(String(fetchModel.mock.calls[0][0])).toBe(
          'https://synthetic.invalid/v1/messages',
        );
        expect(headers.get('authorization')).toBe('Bearer selected-key');
        expect(headers.has('x-api-key')).toBe(false);
        expect(first).toMatchObject({
          model: 'selected-claude',
          system: [
            {
              type: 'text',
              text: REQUEST.system,
              cache_control: { type: 'ephemeral', ttl: '5m' },
            },
          ],
          stream: true,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
          cache_control: { type: 'ephemeral', ttl: '5m' },
          tool_choice: {
            type: 'auto',
          },
        });
        const next = yield* configured.prepareTurn(
          JSON.parse(
            JSON.stringify({
              ...REQUEST,
              messages: [
                ...REQUEST.messages,
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
                        { kind: 'text', text: 'ok' },
                        { kind: 'image', mimeType: 'image/png', base64: '' },
                      ],
                    },
                    {
                      callOrdinal: 1,
                      status: 'error',
                      content: [
                        {
                          kind: 'document',
                          mimeType: 'application/pdf',
                          base64: 'AA==',
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          ),
        );
        assert(next.mode === 'foreground');
        fetchModel.mockImplementationOnce(async () =>
          response([initial(), ...terminal()]),
        );
        yield* completedTurn(configured.streamTurn(next));
        const sent = sentBody(1);
        expect(sent.system).toEqual(first.system);
        expect(sent.cache_control).toEqual(first.cache_control);
        expect(sent.messages.slice(1)).toEqual([
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: '  returned thinking\n',
                signature: 'signature-a',
              },
              { type: 'thinking', thinking: '', signature: 'signature-empty' },
              { type: 'redacted_thinking', data: 'opaque-redacted' },
              { type: 'text', text: '  calling tools\n' },
              {
                type: 'tool_use',
                id: 'call_0',
                name: 'search',
                input: { q: 'x' },
              },
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'fetch',
                input: { q: 'x' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_0',
                is_error: false,
                content: [
                  { type: 'text', text: 'ok' },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: '',
                    },
                  },
                ],
              },
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                is_error: true,
                content: [
                  {
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: 'AA==',
                    },
                  },
                ],
              },
            ],
          },
        ]);
      }),
  );

  // Failure mode: a stored turn whose codec version is not this build's
  // failed to decode, so a run holding one could not continue. It is not
  // the same origin, so it replays as plain content, without its reasoning.
  it.effect(
    'replays a turn of another codec version without its reasoning',
    () =>
      Effect.gen(function* () {
        const configured = model();
        const prepared = yield* configured.prepareTurn(REQUEST);
        assert(prepared.mode === 'foreground');
        const result = yield* completedTurn(configured.streamTurn(prepared));
        const next = yield* configured.prepareTurn(
          JSON.parse(
            JSON.stringify({
              ...REQUEST,
              messages: [
                ...REQUEST.messages,
                {
                  role: 'assistant',
                  origin: { ...result.requestedOrigin, codecVersion: 2 },
                  content: result.content,
                },
                {
                  role: 'tool',
                  results: [0, 1].map((callOrdinal) => ({
                    callOrdinal,
                    status: 'success',
                    content: [{ kind: 'text', text: 'ok' }],
                  })),
                },
              ],
            }),
          ),
        );
        assert(next.mode === 'foreground');
        fetchModel.mockImplementationOnce(async () =>
          response([initial(), ...terminal()]),
        );
        yield* completedTurn(configured.streamTurn(next));
        const sent = sentBody(1);
        expect(
          sent.messages[1].content.map(({ type }: { type: string }) => type),
        ).toEqual(['text', 'tool_use', 'tool_use']);
      }),
  );

  it('rejects ambient custom headers before they override the selected credentials', () => {
    vi.stubEnv(
      'ANTHROPIC_CUSTOM_HEADERS',
      'X-Api-Key: another-key\nanthropic-version: another-version',
    );
    expect(() => model()).toThrow(
      expect.objectContaining({ _tag: 'ModelError', kind: 'unsupported' }),
    );
  });
});

/*
 * Message threads. Failure modes:
 * - a turn that extends the stored response resends the whole history, or
 *   sends system/tools a continue must leave out;
 * - the server no longer holds the thread (expired, already continued) and
 *   the turn fails instead of resending the conversation;
 * - the account cannot use threads and every turn keeps failing;
 * - the API cannot store a conversation, so each turn pays a failed
 *   continue before its replay.
 */
describe('Anthropic message threads', () => {
  const fetchModel = vi.fn<typeof fetch>();
  const model = () =>
    anthropicMessagesModel(
      {
        ...CONFIG,
        deployment: {
          ...CONFIG.deployment,
          endpoint: 'https://api.anthropic.com',
        },
      },
      { apiKey: 'selected-key', fetch: fetchModel },
    );
  const rejected = (status: number, code: string) =>
    new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: code,
          details: { error_code: code },
        },
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  const sent = (call: number) => {
    const init = fetchModel.mock.calls[call]![1]!;
    return {
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      beta: new Headers(init.headers).get('anthropic-beta'),
    };
  };
  // Turns that each answer the previous turn's tool calls.
  const turns = Effect.fn(function* (
    bound: ReturnType<typeof model>,
    count = 2,
  ) {
    let messages = REQUEST.messages;
    for (let turn = 0; turn < count; turn++) {
      const prepared = yield* bound.prepareTurn({ ...REQUEST, messages });
      assert(prepared.mode === 'foreground');
      const result = yield* completedTurn(bound.streamTurn(prepared));
      messages = [
        ...messages,
        assistantMessageFromResult(result),
        {
          role: 'tool',
          results: [0, 1].map((callOrdinal) => ({
            callOrdinal,
            status: 'success' as const,
            content: [{ kind: 'text' as const, text: `result ${callOrdinal}` }],
          })),
        },
      ];
    }
  });
  const toolResults = [
    {
      role: 'user',
      content: [0, 1].map((ordinal) => ({
        type: 'tool_result',
        tool_use_id: `call_${ordinal}`,
        is_error: false,
        content: [{ type: 'text', text: `result ${ordinal}` }],
      })),
    },
  ];
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', '');
    fetchModel.mockReset();
    fetchModel.mockImplementation(async () => response(signedEvents()));
  });
  afterEach(() => vi.unstubAllEnvs());

  it.effect('continues the stored response with only the new messages', () =>
    Effect.gen(function* () {
      yield* turns(model());
      const create = sent(0);
      expect(create.beta).toBe('message-threads-2026-08-12');
      expect(create.body.thread).toStrictEqual({ type: 'create' });
      expect(create.body.system).toBeDefined();
      const next = sent(1);
      expect(next.beta).toBe('message-threads-2026-08-12');
      expect(next.body.thread).toStrictEqual({
        type: 'continue',
        previous_message_id: 'msg_1',
      });
      expect(next.body).not.toHaveProperty('system');
      expect(next.body).not.toHaveProperty('tools');
      expect(next.body.messages).toStrictEqual(toolResults);
    }),
  );

  it.effect('resends the whole conversation when the thread is gone', () =>
    Effect.gen(function* () {
      fetchModel
        .mockImplementationOnce(async () => response(signedEvents()))
        .mockImplementationOnce(async () => rejected(404, 'thread_not_found'));
      yield* turns(model());
      expect(fetchModel).toHaveBeenCalledTimes(3);
      const replay = sent(2);
      expect(replay.body.thread).toStrictEqual({ type: 'create' });
      expect(replay.body.system).toBeDefined();
      expect((replay.body.messages as unknown[]).at(-1)).toStrictEqual(
        toolResults[0],
      );
    }),
  );

  it.effect('sends a conversation the API cannot hold whole', () =>
    Effect.gen(function* () {
      const lost = async () => rejected(404, 'thread_not_found');
      fetchModel
        .mockImplementationOnce(async () => response(signedEvents()))
        .mockImplementationOnce(lost)
        .mockImplementationOnce(async () => response(signedEvents()))
        .mockImplementationOnce(lost);
      yield* turns(model(), 4);
      // Turn 3's continue is lost right after turn 2's replay: from then on
      // the conversation goes out whole, with no continue to fail first.
      expect(fetchModel).toHaveBeenCalledTimes(6);
      expect(sent(2).body.thread).toStrictEqual({ type: 'create' });
      for (const call of [4, 5]) {
        expect(sent(call).beta).toBeNull();
        expect(sent(call).body).not.toHaveProperty('thread');
      }
    }),
  );

  it.effect('stops threading when the account cannot use threads', () =>
    Effect.gen(function* () {
      fetchModel.mockImplementationOnce(async () =>
        rejected(400, 'thread_unsupported_request'),
      );
      yield* turns(model());
      expect(fetchModel).toHaveBeenCalledTimes(3);
      for (const call of [1, 2]) {
        expect(sent(call).beta).toBeNull();
        expect(sent(call).body).not.toHaveProperty('thread');
      }
      expect((sent(2).body.messages as unknown[]).length).toBe(3);
    }),
  );
});
