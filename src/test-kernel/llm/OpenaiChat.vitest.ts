// Node.js imports
import assert from 'node:assert/strict';

// Third-party imports
import { openaiChatModel } from '@texra-ai/llm/openai-chat';
import {
  ModelError,
  type ChatConfiguration,
  type Model,
  type TurnEvent,
  type TurnRequest,
} from '@texra-ai/llm/turn';
import { Cause, Effect, Exit, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE_CONFIG = {
  protocol: 'openai-chat' as const,
  requestedModel: 'synthetic-model',
  deployment: {
    endpoint: 'https://synthetic.invalid/v1',
    credentialScope: 'synthetic-account',
  },
  defaults: { temperature: 0, maxOutputTokens: 100, parallelToolCalls: true },
};
const CONFIG = {
  ...BASE_CONFIG,
  supportsTemperature: true,
  supportedEfforts: [],
  defaults: { ...BASE_CONFIG.defaults, effort: null },
};
const OPENAI_REASONING_CONFIG = {
  ...CONFIG,
  supportsTemperature: false,
  supportedEfforts: ['low', 'medium', 'high'],
  defaults: { ...BASE_CONFIG.defaults, temperature: null, effort: 'high' },
} as const satisfies ChatConfiguration;
const REQUEST: TurnRequest = {
  messages: [
    { role: 'user', content: [{ kind: 'text', text: 'Generate YAML.' }] },
  ],
};
const REASONING_CONFIGS = [
  {
    ...BASE_CONFIG,
    protocol: 'deepseek-chat',
    supportedEfforts: ['low', 'high', 'max'],
    supportsForcedToolChoice: false,
    defaults: {
      maxOutputTokens: 100,
      temperature: null,
      thinking: { mode: 'enabled' },
      effort: 'high',
    },
  },
  {
    ...BASE_CONFIG,
    protocol: 'kimi-chat',
    supportsImageInput: true,
    supportsMessageTokenEstimation: false,
    requiresPromptCacheKey: false,
    thinkingControl: 'toggle',
    supportedEfforts: [],
    supportsForcedToolChoice: false,
    temperatureByThinking: { enabled: null, disabled: null },
    defaults: {
      maxOutputTokens: 100,
      thinking: { mode: 'enabled' },
      effort: null,
      preserveThinking: true,
    },
  },
  {
    ...BASE_CONFIG,
    protocol: 'glm-chat',
    supportsImageInput: true,
    supportsThinkingDisabled: false,
    supportedEfforts: ['low', 'high', 'max'],
    defaults: {
      maxOutputTokens: 100,
      temperature: 0.5,
      thinking: { mode: 'enabled' },
      effort: 'high',
      clearThinking: false,
    },
  },
] as const satisfies readonly ChatConfiguration[];

const XAI_CONFIG = {
  ...BASE_CONFIG,
  protocol: 'xai-chat',
  supportsImageInput: true,
  supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
  defaults: { ...BASE_CONFIG.defaults, effort: 'high' },
} as const satisfies ChatConfiguration;
const QWEN_CONFIG = {
  ...BASE_CONFIG,
  protocol: 'dashscope-chat',
  defaults: {
    ...BASE_CONFIG.defaults,
    stopSequences: ['</answer>'],
    thinking: { mode: 'disabled' },
  },
} as const satisfies ChatConfiguration;
const MINIMAX_CONFIG = {
  ...BASE_CONFIG,
  protocol: 'minimax-chat',
  outputMode: 'complete',
  reasoningSplit: true,
  defaults: { ...BASE_CONFIG.defaults, stopSequences: ['</answer>'] },
} as const satisfies ChatConfiguration;

function chunk(overrides: Record<string, unknown> = {}): object {
  return {
    id: 'synthetic-response',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'returned-model-version',
    choices: [
      {
        index: 0,
        delta: { content: 'generated: true' },
        finish_reason: 'stop',
      },
    ],
    ...overrides,
  };
}

function sse(...events: object[]): string {
  return (
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
    'data: [DONE]\n\n'
  );
}

function response(body: BodyInit): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolChunk(
  toolCalls: object[],
  finishReason: string | null = null,
): object {
  return chunk({
    choices: [
      {
        index: 0,
        delta: { tool_calls: toolCalls },
        finish_reason: finishReason,
      },
    ],
  });
}

const TOOLS = ['search', 'fetch'].map((name) => ({
  name,
  description: `Synthetic ${name}`,
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
}));

function call(index: number, overrides: Record<string, unknown> = {}): object {
  return {
    index,
    id: `call_${index}`,
    type: 'function',
    function: { name: TOOLS[index]?.name ?? 'search', arguments: '{}' },
    ...overrides,
  };
}

function modelWith(fetch: typeof globalThis.fetch): Model {
  return openaiChatModel(CONFIG, { apiKey: 'synthetic-not-a-secret', fetch });
}

const generate = (model: Model) =>
  Effect.gen(function* () {
    const turn = yield* model.prepareTurn(REQUEST);
    assert(turn.mode === 'foreground');
    return yield* model.generateTurn(turn);
  });

afterEach(() => vi.unstubAllEnvs());

describe('native OpenAI Chat protocol', () => {
  it.each([true, false])(
    'preserves MiniMax complete JSON and exact replay with split=%s',
    async (reasoningSplit) => {
      const details = [
        {
          type: 'reasoning.text',
          id: 'same',
          format: 'MiniMax-response-v1',
          index: 7,
          text: 'first',
        },
        { id: 'same', index: 7, text: '' },
        {},
      ];
      const message = {
        role: 'assistant',
        content: reasoningSplit ? '' : '<think>original</think>answer',
        name: 'MiniMax AI',
        audio_content: '',
        ...(reasoningSplit
          ? { reasoning_content: 'separate text', reasoning_details: details }
          : {}),
        tool_calls: [
          {
            type: 'function',
            id: 'call_0',
            index: 9,
            function: { name: 'search', arguments: '{"query":"first"}' },
          },
        ],
      };
      const reply = {
        id: 'minimax-response',
        model: 'returned-minimax',
        created: 0,
        object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'tool_calls', message }],
        usage: {
          total_tokens: 19,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 4 },
          total_characters: 0,
        },
        input_sensitive: true,
        input_sensitive_type: 3,
        output_sensitive: true,
        output_sensitive_type: 5,
        output_sensitive_int: 1,
        base_resp: { status_code: 0, status_msg: '' },
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => Response.json(reply));
      const config = structuredClone({
        ...MINIMAX_CONFIG,
        reasoningSplit,
        requestedModel: 'MiniMax-01',
      });
      const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
      const prepared = await Effect.runPromise(
        model.prepareTurn({
          messages: [
            {
              role: 'user',
              content: [
                { kind: 'text', text: 'first' },
                { kind: 'text', text: 'second' },
              ],
            },
          ],
          tools: TOOLS,
          toolChoice: { name: 'search' },
          parallelToolCalls: false,
        }),
      );
      assert(prepared.protocol === 'minimax-chat');
      expect(prepared.outputMode).toBe('complete');
      expect(prepared.controls.reasoningSplit).toBe(reasoningSplit);
      Object.assign(config, { reasoningSplit: !reasoningSplit });
      const events = await Effect.runPromise(
        Stream.runCollect(model.streamTurn(prepared)),
      );
      expect(events.map((event) => event.kind)).toEqual([
        'identified',
        'completed',
      ]);
      const completed = events.at(-1);
      assert(completed?.kind === 'completed');
      const result = completed.result;
      expect(result).toMatchObject({
        providerResponseId: 'minimax-response',
        returnedModel: 'returned-minimax',
        finishReason: 'tool-calls',
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: 19,
          cachedInputTokens: 0,
          reasoningTokens: 4,
          providerUsage: { kind: 'minimax', totalCharacters: 0 },
        },
        finishEvidence: {
          kind: 'minimax',
          inputSensitive: true,
          inputSensitiveType: 3,
          outputSensitive: true,
          outputSensitiveType: 5,
          outputSensitiveInt: 1,
        },
      });
      expect(result.content).toEqual([
        ...(reasoningSplit
          ? [
              {
                kind: 'reasoning',
                summary: [],
                evidence: {
                  kind: 'minimax-reasoning',
                  plain: 'separate text',
                  details,
                },
              },
            ]
          : []),
        {
          kind: 'message',
          content: [{ kind: 'text', text: message.content }],
          evidence: {
            kind: 'minimax-message',
            name: 'MiniMax AI',
            audioContent: '',
          },
        },
        {
          kind: 'local-call',
          providerCallId: 'call_0',
          name: 'search',
          arguments: { query: 'first' },
          evidence: { kind: 'minimax-function-call', index: 9 },
        },
      ]);
      const firstBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(firstBody).toMatchObject({
        model: 'MiniMax-01',
        stream: false,
        reasoning_split: reasoningSplit,
        max_tokens: 100,
        temperature: 0,
        stop: ['</answer>'],
        parallel_tool_calls: false,
        tool_choice: { type: 'function', function: { name: 'search' } },
        messages: [{ role: 'user', content: 'first\nsecond' }],
      });
      for (const key of [
        'stream_options',
        'max_completion_tokens',
        'outputMode',
        'reasoning_effort',
      ])
        expect(firstBody).not.toHaveProperty(key);
      const history: TurnRequest = {
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
                content: [{ kind: 'text', text: 'found' }],
              },
            ],
          },
        ],
        tools: TOOLS,
      };
      const next = await Effect.runPromise(model.prepareTurn(history));
      assert(next.protocol === 'minimax-chat');
      fetch.mockImplementation(async () =>
        Response.json({
          ...reply,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '',
                ...(reasoningSplit
                  ? { reasoning_content: '', reasoning_details: [] }
                  : {}),
              },
            },
          ],
          usage: { completion_tokens: 0 },
        }),
      );
      const final = await Effect.runPromise(model.generateTurn(next));
      expect(final.finishReason).toBe('stop');
      expect(final.content).toEqual([
        ...(reasoningSplit
          ? [
              {
                kind: 'reasoning',
                summary: [],
                evidence: { kind: 'minimax-reasoning', plain: '', details: [] },
              },
            ]
          : []),
        { kind: 'message', content: [{ kind: 'text', text: '' }] },
      ]);
      expect(final.usage).toEqual({
        inputTokens: null,
        outputTokens: 0,
        totalTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      });
      expect(
        JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages[1],
      ).toEqual(message);
      expect(Object.isFrozen(result.content)).toBe(true);
      const thought = result.content[0];
      if (
        thought.kind === 'reasoning' &&
        thought.evidence?.kind === 'minimax-reasoning'
      ) {
        expect(Object.isFrozen(thought.evidence.details)).toBe(true);
        expect(Object.isFrozen(thought.evidence.details?.[0])).toBe(true);
      }
      for (const controls of [
        { reasoningSplit: !reasoningSplit },
        { toolChoice: { name: 'missing' } },
      ]) {
        const failure = await Effect.runPromise(
          Effect.flip(
            model.generateTurn({
              ...next,
              controls: { ...next.controls, ...controls },
            }),
          ),
        );
        expect(['unsupported', 'invalid-request']).toContain(failure.kind);
      }
      for (const request of [
        { effort: null },
        { thinking: { mode: 'disabled' } },
        { mode: 'background' },
        {
          messages: [
            {
              role: 'user',
              content: [{ kind: 'image', mimeType: 'image/png', base64: '' }],
            },
          ],
        },
      ] as const) {
        const failure = await Effect.runPromise(
          Effect.flip(model.prepareTurn({ ...REQUEST, ...request })),
        );
        expect(failure.kind).toBe('unsupported');
      }
      const foreign = modelWith(vi.fn<typeof globalThis.fetch>());
      expect(
        (await Effect.runPromise(Effect.flip(foreign.prepareTurn(history))))
          .kind,
      ).toBe('unsupported');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { name: 'input detection', finish: 'stop', input_sensitive: true },
    {
      name: 'filtered empty reply',
      finish: 'content_filter',
      output_sensitive: true,
    },
    { name: 'limited empty reply', finish: 'length' },
    { name: 'provider refusal code', code: 1027, kind: 'provider-rejection' },
    {
      name: 'provider authentication code',
      code: 1004,
      noIdentity: true,
      kind: 'authentication',
    },
    {
      name: 'missing terminal reason',
      finish: undefined,
      kind: 'malformed-output',
    },
    {
      name: 'contradictory tools',
      finish: 'tool_calls',
      kind: 'malformed-output',
    },
    {
      name: 'unrepresented audio',
      finish: 'stop',
      extraMessage: { audio_content: 'audio bytes' },
      kind: 'malformed-output',
    },
    {
      name: 'unknown reasoning payload',
      finish: 'stop',
      extraMessage: { reasoning_details: [{ data: 'opaque' }] },
      kind: 'malformed-output',
    },
    {
      name: 'null reasoning',
      finish: 'stop',
      extraMessage: { reasoning_content: null },
      kind: 'malformed-output',
    },
    {
      name: 'malformed call arguments',
      finish: 'tool_calls',
      kind: 'malformed-output',
      extraMessage: {
        tool_calls: [call(0, { function: { name: 'search', arguments: '{' } })],
      },
    },
    {
      name: 'duplicate call identities',
      finish: 'tool_calls',
      kind: 'malformed-output',
      extraMessage: { tool_calls: [call(0), call(1, { id: 'call_0' })] },
    },
  ])(
    'respects MiniMax terminal evidence: $name',
    async ({ finish, code, kind, extraMessage, noIdentity, ...flags }) => {
      const raw = {
        id: noIdentity ? '' : 'minimax-response',
        model: noIdentity ? '' : 'returned-minimax',
        object: 'chat.completion',
        created: 0,
        choices: [
          {
            index: 0,
            finish_reason: finish,
            message: { role: 'assistant', content: '', ...extraMessage },
          },
        ],
        ...(code === undefined
          ? {}
          : {
              base_resp: {
                status_code: code,
                status_msg: 'original rejection',
              },
            }),
        ...(flags.input_sensitive === undefined
          ? {}
          : { input_sensitive: flags.input_sensitive }),
        ...(flags.output_sensitive === undefined
          ? {}
          : { output_sensitive: flags.output_sensitive }),
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () =>
          Response.json(raw, {
            headers: { 'x-request-id': 'minimax-request' },
          }),
        );
      const model = openaiChatModel(MINIMAX_CONFIG, {
        apiKey: 'synthetic',
        fetch,
      });
      if (kind !== undefined) {
        const failure = await Effect.runPromise(Effect.flip(generate(model)));
        expect(failure).toMatchObject({
          kind,
          responseId: noIdentity ? undefined : 'minimax-response',
          model: noIdentity
            ? MINIMAX_CONFIG.requestedModel
            : 'returned-minimax',
          requestId: 'minimax-request',
        });
        if (code !== undefined) {
          expect(failure.status).toBe(200);
          expect(failure.providerEvidence).toMatchObject({
            kind: 'minimax',
            statusCode: code,
            statusMessage: 'original rejection',
          });
          expect(failure.cause).toEqual(raw);
        }
      } else {
        const result = await Effect.runPromise(generate(model));
        expect(result.finishReason).toBe(finish?.replaceAll('_', '-'));
        expect(result.usage).toBeNull();
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([REASONING_CONFIGS[1], REASONING_CONFIGS[2]])(
    'preserves selected $protocol image input and rejects unsupported media before I/O',
    async (config) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => response(sse(chunk())));
      const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
      const request: TurnRequest = {
        system: 'Exact system.',
        messages: [
          {
            role: 'user',
            content: [
              { kind: 'text', text: 'First image: ' },
              { kind: 'image', mimeType: 'image/PNG', base64: 'YQ==' },
              { kind: 'text', text: '\nEmpty captured image: ' },
              { kind: 'image', mimeType: 'image/jpeg', base64: '' },
              { kind: 'text', text: '\nCompare.' },
            ],
          },
        ],
      };
      const prepared = await Effect.runPromise(model.prepareTurn(request));
      expect(fetch).not.toHaveBeenCalled();
      const result = await Effect.runPromise(
        model.generateTurn(JSON.parse(JSON.stringify(prepared))),
      );
      const first = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(first.messages).toEqual([
        { role: 'system', content: request.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First image: ' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/PNG;base64,YQ==' },
            },
            { type: 'text', text: '\nEmpty captured image: ' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,' },
            },
            { type: 'text', text: '\nCompare.' },
          ],
        },
      ]);
      const followUp = await Effect.runPromise(
        model.prepareTurn({
          ...request,
          messages: [
            ...request.messages,
            {
              role: 'assistant',
              origin: result.requestedOrigin,
              content: result.content,
            },
            { role: 'user', content: [{ kind: 'text', text: 'Continue.' }] },
          ],
        }),
      );
      await Effect.runPromise(
        model.generateTurn(JSON.parse(JSON.stringify(followUp))),
      );
      expect(
        JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages.slice(0, 2),
      ).toEqual(first.messages);
      for (const part of [
        { kind: 'image', mimeType: 'image/png', base64: '', detail: 'high' },
        { kind: 'image', mimeType: 'application/pdf', base64: '' },
        {
          kind: 'image',
          mimeType: 'image/png;base64,SGVsbG8=#',
          base64: 'AA==',
        },
        { kind: 'image', mimeType: 'image/svg+xml', base64: 'YQ==' },
        { kind: 'audio', mimeType: 'audio/wav', base64: '' },
        { kind: 'video', mimeType: 'video/mp4', base64: '' },
        { kind: 'document', mimeType: 'application/pdf', base64: '' },
      ] as const) {
        const messages = [{ role: 'user', content: [part] }] as const;
        expect(
          (
            await Effect.runPromise(
              Effect.flip(model.prepareTurn({ messages })),
            )
          ).kind,
        ).toBe('unsupported');
        expect(
          (
            await Effect.runPromise(
              Effect.flip(
                model.generateTurn({
                  ...JSON.parse(JSON.stringify(prepared)),
                  messages,
                }),
              ),
            )
          ).kind,
        ).toBe('unsupported');
      }
      const textOnly = openaiChatModel(
        { ...config, supportsImageInput: false },
        {
          apiKey: 'synthetic',
          fetch,
        },
      );
      expect(
        (await Effect.runPromise(Effect.flip(textOnly.prepareTurn(request))))
          .kind,
      ).toBe('unsupported');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('estimates Kimi messages explicitly and preserves the caller cache key on generation', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"data":{"total_tokens":17}}', {
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'estimate-original',
          },
        }),
      )
      .mockResolvedValueOnce(response(sse(chunk())));
    const config = {
      ...REASONING_CONFIGS[1],
      supportsMessageTokenEstimation: true,
      requiresPromptCacheKey: true,
    };
    const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
    assert(model.estimateMessageTokens !== undefined);
    const missingKey = await Effect.runPromise(
      Effect.flip(model.prepareTurn(REQUEST)),
    );
    expect(missingKey.kind).toBe('invalid-request');
    const promptCacheKey = ' retained-session-key ';
    const prepared = await Effect.runPromise(
      model.prepareTurn({
        system: 'Estimate this system too.',
        promptCacheKey,
        tools: TOOLS,
        messages: [
          {
            role: 'user',
            content: [
              { kind: 'text', text: 'Image: ' },
              { kind: 'image', mimeType: 'image/png', base64: 'YQ==' },
            ],
          },
          {
            role: 'assistant',
            origin: {
              protocol: config.protocol,
              codecVersion: 1,
              requestedModel: config.requestedModel,
              deployment: config.deployment,
            },
            content: [
              {
                kind: 'reasoning',
                summary: [],
                content: [{ kind: 'text', text: 'exact reasoning' }],
                evidence: { kind: 'chat-reasoning-content' },
              },
              {
                kind: 'local-call',
                providerCallId: 'original-call',
                name: 'search',
                arguments: { query: 'x' },
              },
            ],
          },
          {
            role: 'tool',
            results: [
              {
                callOrdinal: 0,
                status: 'success',
                content: [{ kind: 'text', text: 'found' }],
              },
            ],
          },
        ],
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    const rehydrated = JSON.parse(JSON.stringify(prepared));
    expect(
      await Effect.runPromise(model.estimateMessageTokens(rehydrated)),
    ).toBe(17);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${config.deployment.endpoint}/tokenizers/estimate-token-count`,
    );
    const estimate = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(Object.keys(estimate).sort()).toEqual(['messages', 'model']);
    expect(estimate.messages[2]).toMatchObject({
      reasoning_content: 'exact reasoning',
      tool_calls: [
        {
          id: 'original-call',
          function: { name: 'search', arguments: '{"query":"x"}' },
        },
      ],
    });
    await Effect.runPromise(model.generateTurn(rehydrated));
    const generation = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect({ model: generation.model, messages: generation.messages }).toEqual(
      estimate,
    );
    expect(generation).toMatchObject({
      prompt_cache_key: promptCacheKey,
      max_tokens: 100,
    });
    expect(rehydrated.controls).toMatchObject({
      promptCacheKey,
      maxOutputTokens: 100,
    });
    for (const rejected of [
      {
        ...rehydrated,
        controls: { ...rehydrated.controls, promptCacheKey: null },
      },
      {
        ...rehydrated,
        deployment: { ...config.deployment, credentialScope: 'foreign' },
      },
    ]) {
      await Effect.runPromise(
        Effect.flip(model.estimateMessageTokens(rejected)),
      );
      await Effect.runPromise(Effect.flip(model.generateTurn(rejected)));
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    const ordinary = openaiChatModel(REASONING_CONFIGS[1], {
      apiKey: 'synthetic',
      fetch,
    });
    expect(ordinary.estimateMessageTokens).toBeUndefined();
    const ordinaryTurn = await Effect.runPromise(ordinary.prepareTurn(REQUEST));
    assert(ordinaryTurn.protocol === 'kimi-chat');
    expect(ordinaryTurn.controls.promptCacheKey).toBeNull();
  });

  it.each([
    {
      name: 'malformed JSON',
      body: '{',
      status: 200,
      kind: 'malformed-output',
    },
    {
      name: 'negative estimate',
      body: '{"data":{"total_tokens":-1}}',
      status: 200,
      kind: 'malformed-output',
    },
    {
      name: 'error alongside a count',
      body: '{"data":{"total_tokens":3},"error":{"message":"failed"}}',
      status: 200,
      kind: 'malformed-output',
    },
    {
      name: 'authentication failure',
      body: '{"error":{"message":"denied"}}',
      status: 401,
      kind: 'authentication',
    },
    {
      name: 'rate limit',
      body: '{"error":{"message":"limited"}}',
      status: 429,
      kind: 'provider-rejection',
    },
  ])(
    'rejects Kimi estimate $name without retrying',
    async ({ body, status, kind }) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(body, {
          status,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'estimate-original',
          },
        }),
      );
      const model = openaiChatModel(
        { ...REASONING_CONFIGS[1], supportsMessageTokenEstimation: true },
        {
          apiKey: 'synthetic',
          fetch,
        },
      );
      assert(model.estimateMessageTokens !== undefined);
      const turn = await Effect.runPromise(model.prepareTurn(REQUEST));
      const failure = await Effect.runPromise(
        Effect.flip(model.estimateMessageTokens(turn)),
      );
      expect(failure).toMatchObject({ kind, requestId: 'estimate-original' });
      expect(failure.cause).toBeDefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    [REASONING_CONFIGS[1], XAI_CONFIG].flatMap((config) => [
      { config, present: true, fragmented: false },
      { config, present: true, fragmented: true },
      { config, present: false, fragmented: true },
    ]),
  )(
    'requires the $config.protocol terminal sentinel (present: $present; fragmented: $fragmented)',
    async ({ config, present, fragmented }) => {
      const body =
        'retry: 1000\r\n: connection hint\r\n\r\n' +
        `data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'x² 🙂' }, finish_reason: 'stop' }] }))}\r\n\r\n` +
        (present
          ? 'data: [DONE]\r\n\r\ndata: ignored malformed tail\r\n\r\n'
          : '');
      const bytes = new TextEncoder().encode(body);
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        response(
          fragmented
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const byte of bytes)
                    controller.enqueue(Uint8Array.of(byte));
                  controller.close();
                },
              })
            : body,
        ),
      );
      const model = openaiChatModel(config, {
        apiKey: 'synthetic',
        fetch,
      });
      const turn = await Effect.runPromise(model.prepareTurn(REQUEST));
      assert(turn.mode === 'foreground');
      const events: TurnEvent[] = [];
      const collect = Stream.runForEach(model.streamTurn(turn), (event) =>
        Effect.sync(() => events.push(event)),
      );
      if (present) {
        await Effect.runPromise(collect);
        const completed = events.at(-1);
        assert(completed?.kind === 'completed');
        const result = completed.result;
        expect(result.finishReason).toBe('stop');
        expect(result.content).toEqual([
          { kind: 'message', content: [{ kind: 'text', text: 'x² 🙂' }] },
        ]);
      } else {
        const failure = await Effect.runPromise(Effect.flip(collect));
        expect(failure).toMatchObject({
          kind: 'malformed-output',
          responseId: 'synthetic-response',
        });
      }
      expect(events.filter((event) => event.kind === 'phase')).toEqual([
        {
          kind: 'phase',
          part: 'text',
          boundary: 'start',
          providerItemIndex: null,
        },
        ...(present
          ? [
              {
                kind: 'phase',
                part: 'text',
                boundary: 'end',
                providerItemIndex: null,
              },
            ]
          : []),
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { name: 'choice only', root: false, cached: 0 },
    { name: 'root with unknown cache', root: true, cached: null },
  ])(
    'uses Kimi $name usage without merging receipts',
    async ({ root, cached }) => {
      const receipt = {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
      };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        response(
          sse(
            chunk({
              choices: [
                {
                  index: 0,
                  delta: { content: 'done' },
                  finish_reason: 'stop',
                  usage: { ...receipt, cached_tokens: 0 },
                },
              ],
            }),
            ...(root ? [chunk({ choices: [], usage: receipt })] : []),
          ),
        ),
      );
      const model = openaiChatModel(REASONING_CONFIGS[1], {
        apiKey: 'synthetic',
        fetch,
      });
      const result = await Effect.runPromise(generate(model));
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cachedInputTokens: cached,
        reasoningTokens: null,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: 'contradictory Kimi receipts',
      config: REASONING_CONFIGS[1],
      root: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      choice: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      delta: { content: 'done' },
    },
    {
      name: 'contradictory DeepSeek cache fields',
      config: REASONING_CONFIGS[0],
      root: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_cache_hit_tokens: 3,
        prompt_tokens_details: { cached_tokens: 2 },
      },
      delta: { content: 'done' },
    },
    {
      name: 'inconsistent DeepSeek cache partition',
      config: REASONING_CONFIGS[0],
      root: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 8,
      },
      delta: { content: 'done' },
    },
    {
      name: 'malformed GLM reasoning',
      config: REASONING_CONFIGS[2],
      delta: { reasoning_content: 5 },
    },
    {
      name: 'unsupported GLM choice receipt',
      config: REASONING_CONFIGS[2],
      choice: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      delta: { content: 'done' },
    },
    {
      name: 'DeepSeek resource exhaustion',
      config: REASONING_CONFIGS[0],
      delta: { role: null, content: '' },
      finish: 'insufficient_system_resource',
      kind: 'provider-rejection',
    },
    {
      name: 'Qwen legacy function call',
      config: QWEN_CONFIG,
      delta: { function_call: { name: 'search', arguments: '{}' } },
    },
    {
      name: 'Qwen malformed reasoning',
      config: QWEN_CONFIG,
      delta: { reasoning_content: [] },
    },
    {
      name: 'xAI malformed reasoning',
      config: XAI_CONFIG,
      delta: { reasoning_content: {} },
    },
    {
      name: 'xAI nonterminal end_turn',
      config: XAI_CONFIG,
      delta: { content: 'partial' },
      finish: 'end_turn',
    },
    {
      name: 'xAI missing final finish',
      config: XAI_CONFIG,
      delta: { content: 'partial' },
      omitFinish: true,
    },
    {
      name: 'xAI malformed cost',
      config: XAI_CONFIG,
      delta: { content: 'done' },
      root: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        cost_in_usd_ticks: '7',
      },
    },
  ])(
    'does not complete after $name',
    async ({ config, root, choice, delta, finish, kind, omitFinish }) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        response(
          sse(
            chunk({
              ...(config.protocol === 'glm-chat'
                ? { request_id: 'glm-original-request' }
                : {}),
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: 'partial' },
                  finish_reason: null,
                },
              ],
            }),
            chunk({
              usage: root,
              choices: [
                {
                  index: 0,
                  delta,
                  ...(omitFinish ? {} : { finish_reason: finish ?? 'stop' }),
                  usage: choice,
                },
              ],
            }),
          ),
        ),
      );
      const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
      const completed = vi.fn();
      const failure = await Effect.runPromise(
        Effect.flip(
          model.prepareTurn(REQUEST).pipe(
            Effect.flatMap((turn) => {
              assert(turn.mode === 'foreground');
              return Stream.runForEach(model.streamTurn(turn), (event) =>
                Effect.sync(() => {
                  if (event.kind === 'completed') completed();
                }),
              );
            }),
          ),
        ),
      );
      expect(failure).toMatchObject({
        kind: kind ?? 'malformed-output',
        responseId: 'synthetic-response',
        model: 'returned-model-version',
      });
      if (config.protocol === 'glm-chat')
        expect(failure.requestId).toBe('glm-original-request');
      expect(completed).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { config: OPENAI_REASONING_CONFIG, controls: { temperature: 0 } },
    { config: OPENAI_REASONING_CONFIG, controls: { effort: 'xhigh' } },
    { config: REASONING_CONFIGS[0], controls: { temperature: 1 } },
    { config: REASONING_CONFIGS[1], controls: { temperature: 1 } },
    {
      config: REASONING_CONFIGS[2],
      controls: { thinking: { mode: 'disabled' }, effort: null },
    },
    {
      config: {
        ...XAI_CONFIG,
        supportedEfforts: ['low', 'medium', 'high'] as const,
      },
      controls: { effort: 'xhigh' },
    },
    { config: QWEN_CONFIG, controls: { thinking: { mode: 'enabled' } } },
  ])(
    'revalidates rehydrated $config.protocol controls before transport',
    async ({ config, controls }) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
      const prepared = await Effect.runPromise(model.prepareTurn(REQUEST));
      const rehydrated = JSON.parse(JSON.stringify(prepared));
      Object.assign(rehydrated.controls, controls);
      const failure = await Effect.runPromise(
        Effect.flip(model.generateTurn(rehydrated)),
      );
      expect(failure.kind).toBe('unsupported');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'OpenAI selected reasoning default',
      config: OPENAI_REASONING_CONFIG,
      request: {},
      wire: { max_completion_tokens: 100, reasoning_effort: 'high' },
      omitted: ['temperature', 'max_tokens'],
    },
    {
      name: 'OpenAI authored reasoning effort',
      config: OPENAI_REASONING_CONFIG,
      request: { effort: 'low' },
      wire: { max_completion_tokens: 100, reasoning_effort: 'low' },
      omitted: ['temperature', 'max_tokens'],
    },
    {
      name: 'OpenAI explicit null effort',
      config: OPENAI_REASONING_CONFIG,
      request: { effort: null },
      wire: { max_completion_tokens: 100 },
      omitted: ['temperature', 'reasoning_effort', 'max_tokens'],
    },
    {
      name: 'OpenAI selected none effort',
      config: { ...CONFIG, supportedEfforts: ['none'] },
      request: { effort: 'none' },
      wire: { temperature: 0, reasoning_effort: 'none' },
      omitted: ['max_tokens'],
    },
    {
      name: 'DeepSeek non-thinking named tool',
      config: { ...REASONING_CONFIGS[0], supportsForcedToolChoice: true },
      request: {
        thinking: { mode: 'disabled' },
        temperature: 0.4,
        toolChoice: { name: 'search' },
      },
      wire: {
        thinking: { type: 'disabled' },
        temperature: 0.4,
        tool_choice: { type: 'function', function: { name: 'search' } },
      },
      omitted: ['reasoning_effort'],
    },
    {
      name: 'Kimi fixed non-thinking temperature',
      config: {
        ...REASONING_CONFIGS[1],
        temperatureByThinking: { enabled: 1, disabled: 0.6 },
      },
      request: { thinking: { mode: 'disabled' } },
      wire: { thinking: { type: 'disabled', keep: 'all' }, temperature: 0.6 },
      omitted: ['reasoning_effort'],
    },
    {
      name: 'Kimi always-thinking route',
      config: { ...REASONING_CONFIGS[1], thinkingControl: 'always' },
      request: {},
      wire: {},
      omitted: ['thinking', 'temperature', 'reasoning_effort'],
    },
    {
      name: 'Kimi effort-controlled route',
      config: {
        ...REASONING_CONFIGS[1],
        thinkingControl: 'effort',
        supportedEfforts: ['low', 'high', 'max'],
        defaults: { ...REASONING_CONFIGS[1].defaults, effort: 'max' },
      },
      request: { effort: 'low' },
      wire: { reasoning_effort: 'low' },
      omitted: ['thinking', 'temperature'],
    },
    {
      name: 'GLM selected non-thinking support',
      config: { ...REASONING_CONFIGS[2], supportsThinkingDisabled: true },
      request: { thinking: { mode: 'disabled' }, temperature: 0.8 },
      wire: {
        thinking: { type: 'disabled', clear_thinking: false },
        temperature: 0.8,
      },
      omitted: ['reasoning_effort'],
    },
  ] as const satisfies readonly {
    name: string;
    config: ChatConfiguration;
    request: Partial<TurnRequest>;
    wire: object;
    omitted: readonly string[];
  }[])(
    'freezes and sends selected controls for $name',
    async ({ config, request, wire, omitted }) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(sse(chunk())));
      const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
      const prepared = await Effect.runPromise(
        model.prepareTurn({ ...REQUEST, tools: TOOLS, ...request }),
      );
      await Effect.runPromise(
        model.generateTurn(JSON.parse(JSON.stringify(prepared))),
      );
      const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject(wire);
      for (const key of omitted) expect(body).not.toHaveProperty(key);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: 'OpenAI unsupported authored temperature',
      config: OPENAI_REASONING_CONFIG,
      request: { temperature: 0 },
    },
    {
      name: 'OpenAI unsupported authored effort',
      config: OPENAI_REASONING_CONFIG,
      request: { effort: 'xhigh' },
    },
    {
      name: 'DeepSeek thinking temperature',
      config: REASONING_CONFIGS[0],
      request: { temperature: 0.5 },
    },
    {
      name: 'DeepSeek unsupported effort',
      config: REASONING_CONFIGS[0],
      request: { effort: 'medium' },
    },
    {
      name: 'DeepSeek disabled effort',
      config: REASONING_CONFIGS[0],
      request: { thinking: { mode: 'disabled' }, effort: 'high' },
    },
    {
      name: 'DeepSeek forced tool',
      config: REASONING_CONFIGS[0],
      request: { toolChoice: { name: 'search' } },
    },
    {
      name: 'Kimi omitted temperature',
      config: REASONING_CONFIGS[1],
      request: { temperature: 0 },
    },
    {
      name: 'Kimi toggle effort',
      config: REASONING_CONFIGS[1],
      request: { effort: 'high' },
    },
    {
      name: 'Kimi always-thinking author control',
      config: { ...REASONING_CONFIGS[1], thinkingControl: 'always' },
      request: { thinking: { mode: 'enabled' } },
    },
    {
      name: 'GLM forced tool',
      config: REASONING_CONFIGS[2],
      request: { toolChoice: { name: 'search' } },
    },
    {
      name: 'GLM disabled thinking',
      config: REASONING_CONFIGS[2],
      request: { thinking: { mode: 'disabled' } },
    },
    {
      name: 'GLM temperature range',
      config: REASONING_CONFIGS[2],
      request: { temperature: 1.5 },
    },
    {
      name: 'Chat reasoning parallel control',
      config: REASONING_CONFIGS[0],
      request: { parallelToolCalls: false },
    },
    {
      name: 'Chat reasoning token budget',
      config: REASONING_CONFIGS[0],
      request: { thinking: { mode: 'enabled', budgetTokens: 1024 } },
    },
    {
      name: 'Qwen authored thinking',
      config: QWEN_CONFIG,
      request: { thinking: { mode: 'enabled' } },
    },
    {
      name: 'Qwen authored effort',
      config: QWEN_CONFIG,
      request: { effort: 'high' },
    },
    {
      name: 'Qwen unsupported temperature',
      config: QWEN_CONFIG,
      request: { temperature: 2 },
    },
    {
      name: 'xAI authored thinking',
      config: XAI_CONFIG,
      request: { thinking: { mode: 'disabled' } },
    },
    {
      name: 'xAI stop sequence',
      config: XAI_CONFIG,
      request: { stopSequences: ['stop'] },
    },
    {
      name: 'xAI unsupported effort',
      config: XAI_CONFIG,
      request: { effort: 'max' },
    },
    ...[
      { name: 'Qwen image', config: QWEN_CONFIG, mimeType: 'image/png' },
      {
        name: 'xAI unsupported image format',
        config: XAI_CONFIG,
        mimeType: 'image/svg+xml',
      },
      {
        name: 'xAI image delimiter',
        config: XAI_CONFIG,
        mimeType: 'image/png;base64,SGVsbG8=#',
      },
    ].map(({ name, config, mimeType }) => ({
      name,
      config,
      request: {
        messages: [
          {
            role: 'user' as const,
            content: [{ kind: 'image' as const, mimeType, base64: 'AA==' }],
          },
        ],
      },
    })),
  ] as const satisfies readonly {
    name: string;
    config: ChatConfiguration;
    request: Partial<TurnRequest>;
  }[])('rejects $name before transport', async ({ config, request }) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
    const failure = await Effect.runPromise(
      Effect.flip(model.prepareTurn({ ...REQUEST, tools: TOOLS, ...request })),
    );
    expect(failure.kind).toBe('unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([XAI_CONFIG, QWEN_CONFIG])(
    'preserves selected $protocol input, original reasoning and ordered tool follow-up',
    async (config) => {
      const isXai = config.protocol === 'xai-chat';
      const receipt = {
        prompt_tokens: 32,
        completion_tokens: 9,
        total_tokens: 135,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 94 },
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          response(
            sse(
              chunk({
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: '' },
                    ...(isXai ? {} : { finish_reason: null }),
                  },
                ],
                ...(isXai
                  ? {
                      usage: {
                        ...receipt,
                        completion_tokens: 1,
                        total_tokens: 127,
                        cost_in_usd_ticks: 0,
                      },
                      service_tier: 'default',
                    }
                  : {}),
              }),
              ...['  Examine ', 'x².\n'].map((text) =>
                chunk({
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: text },
                      ...(isXai ? {} : { finish_reason: null }),
                    },
                  ],
                }),
              ),
              chunk({
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: null,
                      content: 'Checking.',
                      refusal: null,
                      tool_calls: null,
                      ...(isXai ? {} : { function_call: null }),
                    },
                    finish_reason: null,
                  },
                ],
              }),
              toolChunk([call(0), call(1)], 'tool_calls'),
              chunk({
                choices: [],
                usage: {
                  ...receipt,
                  ...(isXai ? { cost_in_usd_ticks: 70 } : {}),
                },
              }),
              ...(isXai
                ? [
                    chunk({
                      choices: [],
                      usage: { ...receipt, cost_in_usd_ticks: null },
                      service_tier: null,
                    }),
                  ]
                : []),
            ),
          ),
        )
        .mockResolvedValueOnce(
          response(
            sse(
              chunk({
                choices: [
                  {
                    index: 0,
                    delta: {
                      reasoning_content: '',
                      ...(isXai
                        ? { refusal: 'Refused.' }
                        : { content: 'Done.' }),
                    },
                    finish_reason: 'stop',
                  },
                ],
                ...(isXai
                  ? {
                      usage: { ...receipt, cost_in_usd_ticks: 0 },
                      service_tier: 'default',
                    }
                  : {}),
              }),
            ),
          ),
        );
      const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
      const messages: TurnRequest['messages'] = [
        {
          role: 'user',
          content: [
            { kind: 'text', text: 'First' },
            { kind: 'text', text: 'second' },
          ],
        },
        // Neither route requires reasoning on a prior ordinary assistant turn.
        {
          role: 'assistant',
          origin: {
            protocol: config.protocol,
            requestedModel: config.requestedModel,
            deployment: config.deployment,
            codecVersion: 1,
          },
          content: [
            {
              kind: 'message',
              content: [
                { kind: 'text', text: 'Old' },
                { kind: 'text', text: 'reply' },
              ],
            },
          ],
        },
        {
          role: 'user',
          content: [
            { kind: 'text', text: 'Image label' },
            ...(isXai
              ? [
                  {
                    kind: 'image' as const,
                    mimeType: 'image/PNG',
                    base64: '',
                    detail: 'high' as const,
                  },
                ]
              : []),
            { kind: 'text', text: 'Question' },
          ],
        },
      ];
      const prepared = await Effect.runPromise(
        model.prepareTurn({
          messages,
          tools: TOOLS,
          parallelToolCalls: false,
          toolChoice: { name: 'search' },
          ...(isXai
            ? { effort: 'xhigh' as const }
            : { stopSequences: ['<end>'] }),
        }),
      );
      assert(prepared.mode === 'foreground');
      const events = await Effect.runPromise(
        Stream.runCollect(
          model.streamTurn(JSON.parse(JSON.stringify(prepared))),
        ),
      );
      const completed = events.at(-1);
      assert(completed?.kind === 'completed');
      const result = completed.result;
      expect(events[0]?.kind).toBe('identified');
      expect(
        events
          .flatMap((event) =>
            event.kind === 'delta' && event.part === 'reasoning'
              ? [event.text]
              : [],
          )
          .join(''),
      ).toBe('  Examine x².\n');
      expect(result.content[0]).toEqual({
        kind: 'reasoning',
        summary: [],
        content: [{ kind: 'text', text: '  Examine x².\n' }],
        evidence: { kind: 'chat-reasoning-content' },
      });
      expect(
        result.content
          .filter((part) => part.kind === 'local-call')
          .map((part) => part.providerCallId),
      ).toEqual(['call_0', 'call_1']);
      expect(result.usage).toEqual({
        inputTokens: 32,
        outputTokens: 9,
        totalTokens: 135,
        cachedInputTokens: 3,
        reasoningTokens: 94,
        ...(isXai
          ? {
              providerUsage: {
                kind: 'xai',
                costInUsdTicks: 70,
                serviceTier: 'default',
              },
            }
          : {}),
      });
      const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject({
        temperature: 0,
        parallel_tool_calls: false,
        tool_choice: { type: 'function', function: { name: 'search' } },
        stream_options: { include_usage: true },
      });
      if (isXai) {
        expect(body).toMatchObject({
          max_completion_tokens: 100,
          reasoning_effort: 'xhigh',
        });
        expect(body).not.toHaveProperty('max_tokens');
        expect(body).not.toHaveProperty('stop');
        expect(body.messages[2].content).toEqual([
          { type: 'text', text: 'Image label' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/PNG;base64,', detail: 'high' },
          },
          { type: 'text', text: 'Question' },
        ]);
      } else {
        expect(body).toMatchObject({
          max_tokens: 100,
          enable_thinking: false,
          stop: ['<end>'],
        });
        expect(body).not.toHaveProperty('max_completion_tokens');
        expect(body).not.toHaveProperty('reasoning_effort');
        expect(body).not.toHaveProperty('thinking');
        expect(body.messages).toEqual([
          { role: 'user', content: 'First\nsecond' },
          { role: 'assistant', content: 'Old\nreply' },
          { role: 'user', content: 'Image label\nQuestion' },
        ]);
      }
      const followUp = await Effect.runPromise(
        model.prepareTurn({
          tools: TOOLS,
          messages: [
            ...messages,
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
                  content: [{ kind: 'text', text: 'a' }],
                },
                {
                  callOrdinal: 1,
                  status: 'error',
                  content: [{ kind: 'text', text: 'b' }],
                },
              ],
            },
          ],
        }),
      );
      const final = await Effect.runPromise(
        model.generateTurn(JSON.parse(JSON.stringify(followUp))),
      );
      const replay = JSON.parse(
        String(fetch.mock.calls[1]?.[1]?.body),
      ).messages;
      expect(replay.slice(-2)).toEqual([
        { role: 'tool', tool_call_id: 'call_0', content: 'a' },
        { role: 'tool', tool_call_id: 'call_1', content: 'Error: b' },
      ]);
      if (isXai) {
        expect(replay.at(-3).reasoning_content).toBe('  Examine x².\n');
        expect(final.usage?.providerUsage).toEqual({
          kind: 'xai',
          costInUsdTicks: 0,
          serviceTier: 'default',
        });
        expect(final.content.at(-1)).toEqual({
          kind: 'message',
          content: [{ kind: 'refusal', text: 'Refused.' }],
        });
        // xAI reports refusals but its request grammar has no refusal member.
        const failure = await Effect.runPromise(
          Effect.flip(
            model.prepareTurn({
              messages: [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: 'Previous question' }],
                },
                {
                  role: 'assistant',
                  origin: final.requestedOrigin,
                  content: final.content,
                },
                { role: 'user', content: [{ kind: 'text', text: 'Continue' }] },
              ],
            }),
          ),
        );
        expect(failure.kind).toBe('unsupported');
      } else expect(replay.at(-3)).not.toHaveProperty('reasoning_content');
      expect(final.content[0]).toEqual({
        kind: 'reasoning',
        summary: [],
        content: [{ kind: 'text', text: '' }],
        evidence: { kind: 'chat-reasoning-content' },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(REASONING_CONFIGS)(
    'preserves exact $protocol reasoning and complete tool settlements through the SDK',
    async (config) => {
      const receipt = {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        completion_tokens_details: { reasoning_tokens: 2 },
        ...(config.protocol === 'deepseek-chat'
          ? { prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 }
          : {}),
        ...(config.protocol === 'kimi-chat' ? { cached_tokens: 3 } : {}),
        ...(config.protocol === 'glm-chat'
          ? { prompt_tokens_details: { cached_tokens: 3 } }
          : {}),
      };
      const fragments = ['', '  Examine ', 'x².\n'];
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          response(
            sse(
              ...fragments.map((text) =>
                chunk({
                  ...(config.protocol === 'glm-chat'
                    ? { request_id: 'glm-request' }
                    : {}),
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: text },
                      finish_reason: null,
                    },
                  ],
                }),
              ),
              toolChunk([
                call(0, {
                  function: { name: 'search', arguments: '{"query":' },
                }),
                call(1, {
                  function: { name: 'fetch', arguments: '{"query":' },
                }),
              ]),
              chunk({
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: 'Checking.',
                      tool_calls: [
                        { index: 1, function: { arguments: '"b"}' } },
                        { index: 0, function: { arguments: '"a"}' } },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              }),
              chunk({
                ...(config.protocol === 'deepseek-chat'
                  ? { usage: receipt }
                  : {}),
                choices: [
                  {
                    index: 0,
                    delta: { role: null, content: '' },
                    finish_reason: 'tool_calls',
                    ...(config.protocol === 'kimi-chat'
                      ? { usage: receipt }
                      : {}),
                  },
                ],
              }),
              ...(config.protocol === 'deepseek-chat'
                ? []
                : [chunk({ choices: [], usage: receipt })]),
            ),
          ),
        )
        .mockResolvedValueOnce(
          response(
            sse(
              chunk({
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: '', content: 'Done.' },
                    finish_reason: 'stop',
                  },
                ],
              }),
            ),
          ),
        )
        .mockResolvedValueOnce(response(sse(chunk())));
      const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
      const turn = await Effect.runPromise(
        model.prepareTurn({ ...REQUEST, tools: TOOLS }),
      );
      assert(turn.mode === 'foreground');
      const events = await Effect.runPromise(
        Stream.runCollect(model.streamTurn(turn)),
      );
      expect(events[0]?.kind).toBe('identified');
      expect(events.slice(1, -1)).toEqual([
        {
          kind: 'phase',
          part: 'reasoning',
          boundary: 'start',
          providerItemIndex: null,
        },
        {
          kind: 'delta',
          part: 'reasoning',
          text: fragments[1],
          providerItemIndex: null,
        },
        {
          kind: 'delta',
          part: 'reasoning',
          text: fragments[2],
          providerItemIndex: null,
        },
        {
          kind: 'phase',
          part: 'reasoning',
          boundary: 'end',
          providerItemIndex: null,
        },
        {
          kind: 'phase',
          part: 'text',
          boundary: 'start',
          providerItemIndex: null,
        },
        {
          kind: 'delta',
          part: 'text',
          text: 'Checking.',
          providerItemIndex: null,
        },
        {
          kind: 'phase',
          part: 'text',
          boundary: 'end',
          providerItemIndex: null,
        },
      ]);
      const completed = events.at(-1);
      if (completed?.kind !== 'completed')
        throw new Error('Expected one completed turn.');
      const result = completed.result;
      expect(events.filter((event) => event.kind === 'completed')).toHaveLength(
        1,
      );
      expect(result.content).toEqual([
        {
          kind: 'reasoning',
          summary: [],
          content: [{ kind: 'text', text: fragments.join('') }],
          evidence: { kind: 'chat-reasoning-content' },
        },
        { kind: 'message', content: [{ kind: 'text', text: 'Checking.' }] },
        {
          kind: 'local-call',
          providerCallId: 'call_0',
          name: 'search',
          arguments: { query: 'a' },
        },
        {
          kind: 'local-call',
          providerCallId: 'call_1',
          name: 'fetch',
          arguments: { query: 'b' },
        },
      ]);
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cachedInputTokens: 3,
        reasoningTokens: 2,
      });
      const firstBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(firstBody).toMatchObject({ max_tokens: 100, stream: true, n: 1 });
      expect(firstBody).not.toHaveProperty('max_completion_tokens');
      expect(firstBody).not.toHaveProperty('parallel_tool_calls');
      if (config.protocol === 'glm-chat') {
        expect(firstBody).toMatchObject({
          thinking: { type: 'enabled', clear_thinking: false },
          temperature: 0.5,
        });
      } else {
        expect(firstBody).not.toHaveProperty('temperature');
        expect(firstBody.thinking).toEqual(
          config.protocol === 'kimi-chat'
            ? { type: 'enabled', keep: 'all' }
            : { type: 'enabled' },
        );
      }
      const messages: TurnRequest['messages'] = [
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
              content: [{ kind: 'text', text: 'a' }],
            },
            {
              callOrdinal: 1,
              status: 'error',
              content: [{ kind: 'text', text: 'b' }],
            },
          ],
        },
      ];
      const followUp = await Effect.runPromise(
        model.prepareTurn({ messages, tools: TOOLS }),
      );
      const followUpEvents = await Effect.runPromise(
        Stream.runCollect(
          model.streamTurn(JSON.parse(JSON.stringify(followUp))),
        ),
      );
      const followUpCompleted = followUpEvents.at(-1);
      assert(followUpCompleted?.kind === 'completed');
      const final = followUpCompleted.result;
      assert(final.providerResponseId !== null);
      // The reported empty reasoning is replayable content, not an observed phase.
      expect(followUpEvents.filter((event) => event.kind === 'phase')).toEqual([
        {
          kind: 'phase',
          part: 'text',
          boundary: 'start',
          providerItemIndex: null,
        },
        {
          kind: 'phase',
          part: 'text',
          boundary: 'end',
          providerItemIndex: null,
        },
      ]);
      const replayed = JSON.parse(
        String(fetch.mock.calls[1]?.[1]?.body),
      ).messages;
      expect(replayed.slice(1)).toEqual([
        {
          role: 'assistant',
          content: 'Checking.',
          reasoning_content: fragments.join(''),
          tool_calls: [
            {
              type: 'function',
              id: 'call_0',
              function: { name: 'search', arguments: '{"query":"a"}' },
            },
            {
              type: 'function',
              id: 'call_1',
              function: { name: 'fetch', arguments: '{"query":"b"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0', content: 'a' },
        { role: 'tool', tool_call_id: 'call_1', content: 'Error: b' },
      ]);
      const third = await Effect.runPromise(
        model.prepareTurn({
          tools: TOOLS,
          messages: [
            ...messages,
            {
              role: 'assistant',
              origin: final.requestedOrigin,
              content: final.content,
            },
            { role: 'user', content: [{ kind: 'text', text: 'Continue.' }] },
          ],
        }),
      );
      assert(third.mode === 'foreground');
      const last = await Effect.runPromise(model.generateTurn(third));
      const retained = JSON.parse(
        String(fetch.mock.calls[2]?.[1]?.body),
      ).messages;
      expect(retained[1].reasoning_content).toBe(fragments.join(''));
      expect(retained[4]).toEqual({
        role: 'assistant',
        content: 'Done.',
        reasoning_content: '',
      });
      expect(last.usage).toBeNull();
      expect(last.content.some((part) => part.kind === 'reasoning')).toBe(
        false,
      );
      const foreign = await Effect.runPromise(
        Effect.flip(
          model.prepareTurn({
            ...REQUEST,
            messages: [
              ...REQUEST.messages,
              {
                role: 'assistant',
                origin: {
                  ...final.requestedOrigin,
                  deployment: {
                    ...config.deployment,
                    credentialScope: 'foreign',
                  },
                },
                content: final.content,
              },
            ],
          }),
        ),
      );
      expect(foreign.kind).toBe('unsupported');
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it('freezes preparation and collects trailing usage in one execution', async () => {
    vi.stubEnv('OPENAI_ORG_ID', 'unselected-organization');
    vi.stubEnv('OPENAI_PROJECT_ID', 'unselected-project');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response(
        sse(
          chunk({
            choices: [
              {
                index: 0,
                delta: { content: 'generated: true' },
                finish_reason: null,
              },
            ],
          }),
          chunk({
            choices: [
              {
                index: 0,
                delta: { refusal: 'Cannot continue.' },
                finish_reason: 'stop',
              },
            ],
          }),
          chunk({
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          }),
        ),
      ),
    );
    const config = structuredClone(CONFIG);
    const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
    const request = structuredClone(REQUEST);
    const prepared = await Effect.runPromise(model.prepareTurn(request));
    assert(prepared.mode === 'foreground');
    config.defaults.maxOutputTokens = 200;
    config.requestedModel = 'later-model';
    const content = prepared.messages.find(
      (message) => message.role === 'user',
    )?.content;
    expect(content).toHaveLength(1);
    expect(Object.isFrozen(content?.[0])).toBe(true);

    const events = await Effect.runPromise(
      Stream.runCollect(model.streamTurn(prepared)),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'synthetic-model',
      temperature: 0,
      max_completion_tokens: 100,
      n: 1,
      stream: true,
      stream_options: { include_usage: true },
    });
    const headers = new Headers(init?.headers);
    expect(headers.has('openai-organization')).toBe(false);
    expect(headers.has('openai-project')).toBe(false);
    expect(events).toEqual([
      {
        kind: 'identified',
        providerResponseId: 'synthetic-response',
        requestedOrigin: {
          protocol: 'openai-chat',
          codecVersion: 1,
          requestedModel: CONFIG.requestedModel,
          deployment: CONFIG.deployment,
        },
        returnedModel: 'returned-model-version',
      },
      {
        kind: 'phase',
        part: 'text',
        boundary: 'start',
        providerItemIndex: null,
      },
      {
        kind: 'delta',
        part: 'text',
        text: 'generated: true',
        providerItemIndex: null,
      },
      {
        kind: 'delta',
        part: 'refusal',
        text: 'Cannot continue.',
        providerItemIndex: null,
      },
      {
        kind: 'phase',
        part: 'text',
        boundary: 'end',
        providerItemIndex: null,
      },
      {
        kind: 'completed',
        result: {
          providerResponseId: 'synthetic-response',
          requestedOrigin: {
            protocol: 'openai-chat',
            codecVersion: 1,
            requestedModel: 'synthetic-model',
            deployment: CONFIG.deployment,
          },
          returnedModel: 'returned-model-version',
          modelFingerprint: null,
          content: [
            {
              kind: 'message',
              content: [
                { kind: 'text', text: 'generated: true' },
                { kind: 'refusal', text: 'Cannot continue.' },
              ],
            },
          ],
          finishReason: 'stop',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
            cachedInputTokens: 3,
            reasoningTokens: 1,
          },
        },
      },
    ]);
  });

  it('preserves unknown usage and rejects another prepared deployment before sending', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(sse(chunk())));
    const model = modelWith(fetch);
    const result = await Effect.runPromise(generate(model));
    expect(result.usage).toBeNull();
    const prepared = await Effect.runPromise(model.prepareTurn(REQUEST));
    assert(
      prepared.protocol === 'openai-chat' && prepared.mode === 'foreground',
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        model.generateTurn({
          ...prepared,
          deployment: {
            ...prepared.deployment,
            credentialScope: 'another-account',
          },
        }),
      ),
    );
    expect(failure).toMatchObject({ kind: 'unsupported' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('collects indexed calls once and lowers ordered results without losing error status', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response(
          sse(
            chunk({
              choices: [
                {
                  index: 0,
                  delta: { content: 'Checking.' },
                  finish_reason: null,
                },
              ],
            }),
            toolChunk([
              call(1, { function: { name: 'fetch', arguments: '{"query":' } }),
              call(0, { function: { name: 'search', arguments: '{"query":' } }),
            ]),
            toolChunk([
              {
                index: 0,
                id: 'call_0',
                function: { name: 'search', arguments: '"first"}' },
              },
              {
                index: 1,
                id: null,
                type: null,
                function: { name: null, arguments: '"second"}' },
              },
            ]),
            chunk({
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: null },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            chunk({
              choices: [],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 8,
                total_tokens: 18,
              },
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(response(sse(chunk())));
    const model = modelWith(fetch);
    const prepared = await Effect.runPromise(
      model.prepareTurn({ ...REQUEST, tools: TOOLS }),
    );
    assert(prepared.mode === 'foreground');
    const events = await Effect.runPromise(
      Stream.runCollect(model.streamTurn(prepared)),
    );
    expect(events).toHaveLength(5);
    expect(events[0]?.kind).toBe('identified');
    expect(events.slice(1, -1)).toEqual([
      {
        kind: 'phase',
        part: 'text',
        boundary: 'start',
        providerItemIndex: null,
      },
      {
        kind: 'delta',
        part: 'text',
        text: 'Checking.',
        providerItemIndex: null,
      },
      {
        kind: 'phase',
        part: 'text',
        boundary: 'end',
        providerItemIndex: null,
      },
    ]);
    const completed = events.at(-1);
    expect(completed?.kind).toBe('completed');
    if (completed?.kind !== 'completed')
      throw new Error('Missing completed result');
    const result = completed.result;
    expect(result).toMatchObject({
      finishReason: 'tool-calls',
      usage: { totalTokens: 18 },
      content: [
        { kind: 'message', content: [{ kind: 'text', text: 'Checking.' }] },
        {
          kind: 'local-call',
          providerCallId: 'call_0',
          name: 'search',
          arguments: { query: 'first' },
        },
        {
          kind: 'local-call',
          providerCallId: 'call_1',
          name: 'fetch',
          arguments: { query: 'second' },
        },
      ],
    });
    await Effect.runPromise(
      model
        .prepareTurn({
          messages: [
            ...REQUEST.messages,
            {
              role: 'assistant',
              origin: result.requestedOrigin,
              content: [
                {
                  kind: 'message',
                  content: [{ kind: 'text', text: 'Prior context.' }],
                },
                ...result.content,
              ],
            },
            {
              role: 'tool',
              results: [
                {
                  callOrdinal: 0,
                  status: 'success',
                  content: [{ kind: 'text', text: 'same text' }],
                },
                {
                  callOrdinal: 1,
                  status: 'error',
                  content: [{ kind: 'text', text: 'same text' }],
                },
              ],
            },
          ],
          tools: TOOLS,
        })
        .pipe(
          Effect.flatMap((turn) => {
            assert(turn.mode === 'foreground');
            return model.generateTurn(turn);
          }),
        ),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      tools: TOOLS.map((tool) => ({
        type: 'function',
        function: { ...tool, strict: false },
      })),
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages).toEqual(
      [
        { role: 'user', content: 'Generate YAML.' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Prior context.' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Checking.' }],
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"first"}' },
            },
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'fetch', arguments: '{"query":"second"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0', content: 'same text' },
        { role: 'tool', tool_call_id: 'call_1', content: 'Error: same text' },
      ],
    );
  });

  it('freezes configured controls and the required tool before sending', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        response(sse(toolChunk([call(0)], 'tool_calls'))),
      );
    const config = structuredClone(OPENAI_REASONING_CONFIG);
    Object.assign(config.defaults, { parallelToolCalls: false });
    const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
    const choice = { name: 'search' };
    const turn = await Effect.runPromise(
      model.prepareTurn({ ...REQUEST, tools: TOOLS, toolChoice: choice }),
    );
    assert(turn.mode === 'foreground');
    Object.assign(config, {
      supportsTemperature: true,
      supportedEfforts: ['low', 'max'],
    });
    Object.assign(config.defaults, {
      parallelToolCalls: true,
      temperature: 1,
      effort: 'low',
    });
    choice.name = 'fetch';
    await Effect.runPromise(model.generateTurn(turn));
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      parallel_tool_calls: false,
      tool_choice: { type: 'function', function: { name: 'search' } },
      reasoning_effort: 'high',
    });
    expect(body).not.toHaveProperty('temperature');
    await Effect.runPromise(
      model
        .prepareTurn({ ...REQUEST, tools: TOOLS, parallelToolCalls: true })
        .pipe(
          Effect.flatMap((turn) => {
            assert(turn.mode === 'foreground');
            return model.generateTurn(turn);
          }),
        ),
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      parallel_tool_calls: true,
      tool_choice: 'auto',
    });
    const failure = await Effect.runPromise(
      Effect.flip(
        model.prepareTurn({
          ...REQUEST,
          tools: TOOLS,
          toolChoice: { name: 'absent' },
        }),
      ),
    );
    expect(failure.kind).toBe('invalid-request');
    const forged = await Effect.runPromise(
      Effect.flip(
        model.generateTurn({
          ...turn,
          tools: [],
        }),
      ),
    );
    expect(forged.kind).toBe('invalid-request');
    for (const request of [{ temperature: 0 }, { effort: 'max' }] as const) {
      const failure = await Effect.runPromise(
        Effect.flip(model.prepareTurn({ ...REQUEST, ...request })),
      );
      expect(failure.kind).toBe('unsupported');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'user media',
    'tool media',
    'Kimi tool media',
    'GLM tool media',
    'reasoning',
    'missing call ID',
    'text after calls',
    'reasoning control',
    'service-tier control',
    'background mode',
    'thinking control',
    'effort control',
    'none effort',
    'minimal effort',
    'cache control',
    'prompt cache key',
    'stop control',
    'inference geography',
    'Responses message evidence',
    'Responses call evidence',
  ] as const)('rejects unsupported %s before transport', async (scenario) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    let config: ChatConfiguration = CONFIG;
    if (scenario === 'none effort' || scenario === 'minimal effort')
      config = REASONING_CONFIGS[0];
    if (scenario === 'Kimi tool media') config = REASONING_CONFIGS[1];
    if (scenario === 'GLM tool media') config = REASONING_CONFIGS[2];
    const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
    const image = { kind: 'image', mimeType: 'image/png', base64: '' } as const;
    const content = {
      role: 'assistant',
      origin: {
        protocol: config.protocol,
        codecVersion: 1,
        requestedModel: CONFIG.requestedModel,
        deployment: CONFIG.deployment,
      },
      content: [
        {
          kind: 'local-call',
          providerCallId: scenario === 'missing call ID' ? null : 'call_0',
          name: 'search',
          arguments: {},
        },
        ...(scenario === 'text after calls'
          ? [
              {
                kind: 'message' as const,
                content: [{ kind: 'text' as const, text: 'later text' }],
              },
            ]
          : []),
      ],
    } satisfies TurnRequest['messages'][number];
    let request: TurnRequest = {
      messages: [
        ...REQUEST.messages,
        content,
        {
          role: 'tool',
          results: [
            {
              callOrdinal: 0,
              status: 'success',
              content: scenario.includes('tool media')
                ? [image]
                : [{ kind: 'text', text: 'done' }],
            },
          ],
        },
      ],
    };
    if (scenario === 'user media')
      request = { messages: [{ role: 'user', content: [image] }] };
    if (scenario === 'reasoning control')
      request = { ...REQUEST, reasoning: null };
    if (scenario === 'service-tier control')
      request = { ...REQUEST, serviceTier: null };
    if (scenario === 'background mode')
      request = { ...REQUEST, mode: 'background' };
    if (scenario === 'thinking control')
      request = { ...REQUEST, thinking: { mode: 'disabled' } };
    if (scenario === 'effort control') request = { ...REQUEST, effort: 'high' };
    if (scenario === 'none effort') request = { ...REQUEST, effort: 'none' };
    if (scenario === 'minimal effort')
      request = { ...REQUEST, effort: 'minimal' };
    if (scenario === 'cache control')
      request = { ...REQUEST, cache: 'disabled' };
    if (scenario === 'prompt cache key')
      request = { ...REQUEST, promptCacheKey: 'session' };
    if (scenario === 'stop control')
      request = { ...REQUEST, stopSequences: [] };
    if (scenario === 'inference geography')
      request = { ...REQUEST, inferenceGeo: null };
    if (scenario === 'Responses message evidence')
      request = {
        messages: [
          ...REQUEST.messages,
          {
            ...content,
            origin: { ...content.origin, protocol: 'openai-responses' },
            content: [
              {
                kind: 'message',
                content: [{ kind: 'text', text: 'Keep this phase.' }],
                evidence: {
                  kind: 'openai-responses-message',
                  itemId: 'msg_1',
                  status: 'completed',
                  phase: 'commentary',
                },
              },
            ],
          },
        ],
      };
    if (scenario === 'Responses call evidence')
      request = {
        ...request,
        messages: request.messages.map((message) =>
          message.role === 'assistant'
            ? {
                ...message,
                origin: { ...content.origin, protocol: 'openai-responses' },
                content: message.content.map((part) =>
                  part.kind === 'local-call'
                    ? {
                        ...part,
                        evidence: {
                          kind: 'openai-responses-function-call' as const,
                          itemId: 'fc_1',
                        },
                      }
                    : part,
                ),
              }
            : message,
        ),
      };
    if (scenario === 'reasoning')
      request = {
        messages: [
          ...REQUEST.messages,
          {
            ...content,
            content: [
              {
                kind: 'reasoning',
                summary: [{ kind: 'text', text: 'reason' }],
                evidence: null,
              },
            ],
          },
        ],
      };
    const failure = await Effect.runPromise(
      Effect.flip(model.prepareTurn(request)),
    );
    expect(failure.kind).toBe('unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'changed call ID', deltas: [call(0), { index: 0, id: 'changed' }] },
    {
      name: 'changed call name',
      deltas: [call(0), { index: 0, function: { name: 'fetch' } }],
    },
    { name: 'missing call ID', deltas: [call(0, { id: undefined })] },
    { name: 'missing call type', deltas: [call(0, { type: undefined })] },
    {
      name: 'missing call name',
      deltas: [call(0, { function: { arguments: '{}' } })],
    },
    {
      name: 'duplicate call IDs',
      deltas: [call(0), call(1, { id: 'call_0' })],
    },
    { name: 'missing index', deltas: [call(1)] },
    {
      name: 'malformed JSON',
      deltas: [call(0, { function: { name: 'search', arguments: '{' } })],
    },
    {
      name: 'non-object JSON',
      deltas: [call(0, { function: { name: 'search', arguments: '[]' } })],
    },
    {
      name: 'unsupported JSON key',
      deltas: [
        call(0, {
          function: { name: 'search', arguments: '{"__proto__":{}}' },
        }),
      ],
    },
    { name: 'stop with calls', deltas: [call(0)], finish: 'stop' },
    { name: 'truncated calls', deltas: [call(0)], finish: 'length' },
  ])(
    'never completes malformed tool output: $name',
    async ({ deltas, finish }) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          response(
            sse(
              ...deltas.map((delta) => toolChunk([delta])),
              toolChunk([], finish ?? 'tool_calls'),
            ),
          ),
        );
      const model = modelWith(fetch);
      const completed = vi.fn();
      const failure = await Effect.runPromise(
        Effect.flip(
          model.prepareTurn({ ...REQUEST, tools: TOOLS }).pipe(
            Effect.flatMap((turn) => {
              assert(turn.mode === 'foreground');
              return Stream.runForEach(model.streamTurn(turn), (event) =>
                Effect.sync(() => {
                  if (event.kind === 'completed') completed();
                }),
              );
            }),
          ),
        ),
      );
      expect(failure).toMatchObject({
        kind: 'malformed-output',
        responseId: 'synthetic-response',
      });
      expect(completed).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: 'connection',
      send: () => Promise.reject(new TypeError('synthetic connection failure')),
      kind: 'transport',
    },
    {
      name: 'authentication',
      send: async () =>
        new Response('{"error":{"message":"denied"}}', {
          status: 401,
          headers: { 'x-request-id': 'synthetic-request' },
        }),
      kind: 'authentication',
    },
    {
      name: 'rate limiting',
      send: async () =>
        new Response('{"error":{"message":"limited"}}', {
          status: 429,
          headers: { 'x-request-id': 'synthetic-request' },
        }),
      kind: 'provider-rejection',
    },
    {
      name: 'malformed SSE',
      send: async () => response('data: malformed JSON\n\n'),
      kind: 'malformed-output',
    },
  ])('classifies $name without a hidden SDK retry', async ({ send, kind }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(send);
    const failure = await Effect.runPromise(
      Effect.flip(generate(modelWith(fetch))),
    );
    expect(failure).toBeInstanceOf(ModelError);
    expect(failure.kind).toBe(kind);
    expect(failure.message.length).toBeGreaterThan(0);
    expect(failure.cause).toBeDefined();
    if (kind === 'authentication' || kind === 'provider-rejection') {
      expect(failure.requestId).toBe('synthetic-request');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'unfinished response', tail: '' },
    {
      name: 'tool completion without calls',
      tail: sse(
        chunk({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    },
    { name: 'changed identity', tail: sse(chunk({ id: 'another-response' })) },
    { name: 'malformed later event', tail: 'data: malformed JSON\n\n' },
    {
      name: 'provider error event',
      tail: 'event: error\ndata: {"error":{"message":"provider failed","code":"synthetic-code"}}\n\n',
      kind: 'provider-rejection',
    },
    {
      name: 'provider error payload',
      tail: 'data: {"error":{"message":"provider failed","code":"synthetic-code"}}\n\n',
      kind: 'provider-rejection',
    },
  ])(
    'retains available response identity after $name',
    async ({ tail, kind }) => {
      const first = chunk({
        choices: [
          { index: 0, delta: { content: 'partial' }, finish_reason: null },
        ],
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(`data: ${JSON.stringify(first)}\n\n${tail}`, {
          headers: {
            'content-type': 'text/event-stream',
            'x-request-id': 'original-request',
          },
        }),
      );
      const model = modelWith(fetch);
      const prepared = await Effect.runPromise(model.prepareTurn(REQUEST));
      assert(prepared.mode === 'foreground');
      const phases: TurnEvent[] = [];
      const failure = await Effect.runPromise(
        Effect.flip(
          Stream.runForEach(model.streamTurn(prepared), (event) =>
            Effect.sync(() => {
              if (event.kind === 'phase') phases.push(event);
            }),
          ),
        ),
      );
      expect(phases).toEqual([
        {
          kind: 'phase',
          part: 'text',
          boundary: 'start',
          providerItemIndex: null,
        },
      ]);
      expect(failure).toMatchObject({
        kind: kind ?? 'malformed-output',
        responseId: 'synthetic-response',
        model: 'returned-model-version',
        requestId: 'original-request',
      });
      if (kind === 'provider-rejection') {
        expect(failure.message).toContain('provider failed');
        expect(failure.cause).toMatchObject({ code: 'synthetic-code' });
      }
    },
  );

  it.each(['generation', 'estimation', 'MiniMax completion'] as const)(
    'preserves a body-read failure and the HTTP request identity during %s',
    async (operation) => {
      const estimating = operation === 'estimation';
      const complete = operation === 'MiniMax completion';
      const cause = new Error('Original body failure');
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let requestSignal: AbortSignal | null | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(current) {
          controller = current;
          current.enqueue(
            new TextEncoder().encode(
              estimating || complete
                ? '{"data":'
                : `data: ${JSON.stringify(
                    chunk({
                      request_id: 'provider-body-request',
                      choices: [
                        {
                          index: 0,
                          delta: { reasoning_content: 'partial' },
                          finish_reason: null,
                        },
                      ],
                    }),
                  )}\n\n`,
            ),
          );
        },
        pull() {
          if (estimating || complete) controller.error(cause);
        },
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async (_input, init) => {
          requestSignal = init?.signal;
          return new Response(body, {
            headers: {
              'content-type':
                estimating || complete
                  ? 'application/json'
                  : 'text/event-stream',
              'x-request-id': 'http-original-request',
            },
          });
        });
      let config: ChatConfiguration = REASONING_CONFIGS[2];
      if (complete) config = MINIMAX_CONFIG;
      if (estimating)
        config = {
          ...REASONING_CONFIGS[1],
          supportsMessageTokenEstimation: true,
        };
      const model = openaiChatModel(config, {
        apiKey: 'synthetic',
        fetch,
      });
      const prepared = await Effect.runPromise(model.prepareTurn(REQUEST));
      assert(prepared.mode === 'foreground');
      const failure = await Effect.runPromise(
        Effect.flip(
          estimating
            ? model.estimateMessageTokens!(prepared).pipe(Effect.asVoid)
            : Stream.runForEach(model.streamTurn(prepared), (event) =>
                Effect.sync(() => {
                  if (event.kind === 'delta') controller.error(cause);
                }),
              ),
        ),
      );
      expect(failure).toMatchObject({
        kind: 'transport',
        model:
          estimating || complete
            ? CONFIG.requestedModel
            : 'returned-model-version',
        requestId: 'http-original-request',
      });
      expect(failure.responseId).toBe(
        estimating || complete ? undefined : 'synthetic-response',
      );
      expect(failure.cause).toBe(cause);
      expect(requestSignal?.aborted).toBe(true);
      expect(body.locked).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'headers',
    'body',
    'estimate-headers',
    'estimate-body',
    'estimate-interruption-and-cancel',
    'tool arguments',
    'reasoning',
    'successful-take',
    'malformed-frame-and-cancel',
    'interruption-and-cancel',
    'complete-headers',
    'complete-body',
    'complete-interruption-and-cancel',
    'complete-malformed-bytes-and-cancel',
  ] as const)(
    'interrupts a pending %s read and joins cleanup',
    async (phase) => {
      const estimating = phase.startsWith('estimate-');
      const complete = phase.startsWith('complete-');
      const malformed =
        phase === 'malformed-frame-and-cancel' ||
        phase === 'complete-malformed-bytes-and-cancel';
      const waitingForHeaders =
        phase === 'headers' ||
        phase === 'estimate-headers' ||
        phase === 'complete-headers';
      let requestSignal: AbortSignal | null | undefined;
      let cancelledAfterAbort = false;
      const cancellation = new Error('Cancellation failed');
      const cancel = vi.fn(() => {
        cancelledAfterAbort = requestSignal?.aborted ?? false;
        if (
          phase === 'successful-take' ||
          phase === 'malformed-frame-and-cancel' ||
          phase === 'interruption-and-cancel' ||
          phase === 'estimate-interruption-and-cancel' ||
          phase === 'complete-interruption-and-cancel' ||
          phase === 'complete-malformed-bytes-and-cancel'
        )
          throw cancellation;
      });
      const onDelta = vi.fn();
      const onCompleted = vi.fn();
      const onPhaseEnd = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              estimating || complete
                ? '{"data":'
                : `data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: phase === 'reasoning' ? { reasoning_content: 'partial' } : { content: 'partial' }, finish_reason: null }] }))}\n\n`,
            ),
          );
          if (phase === 'tool arguments')
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(toolChunk([call(0, { function: { name: 'search', arguments: '{' } })]))}\n\n`,
              ),
            );
          if (phase === 'malformed-frame-and-cancel')
            controller.enqueue(
              new TextEncoder().encode('data: malformed JSON\n\n'),
            );
          if (phase === 'complete-malformed-bytes-and-cancel')
            controller.enqueue(new Uint8Array([0xff]));
        },
        cancel,
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation((_input, init) => {
          requestSignal = init?.signal;
          if (!waitingForHeaders)
            return Promise.resolve(
              new Response(body, {
                headers: {
                  'content-type':
                    estimating || complete
                      ? 'application/json'
                      : 'text/event-stream',
                },
              }),
            );
          return new Promise((_resolve, reject) =>
            requestSignal?.addEventListener(
              'abort',
              () => reject(requestSignal?.reason),
              { once: true },
            ),
          );
        });
      let config: ChatConfiguration = CONFIG;
      if (complete) config = MINIMAX_CONFIG;
      if (phase === 'reasoning') config = REASONING_CONFIGS[0];
      if (estimating)
        config = {
          ...REASONING_CONFIGS[1],
          supportsMessageTokenEstimation: true,
        };
      const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
      const prepared = await Effect.runPromise(model.prepareTurn(REQUEST));
      assert(prepared.mode === 'foreground');
      if (phase === 'successful-take') {
        await expect(
          Effect.runPromise(
            model.streamTurn(prepared).pipe(
              Stream.filter((event) => event.kind === 'delta'),
              Stream.take(1),
              Stream.runDrain,
            ),
          ),
        ).rejects.toThrow('Cancellation failed');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(cancelledAfterAbort).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
        return;
      }
      const operation = estimating
        ? model.estimateMessageTokens!(prepared)
        : Stream.runForEach(model.streamTurn(prepared), (event) =>
            Effect.sync(() => {
              if (event.kind === 'delta') onDelta();
              if (event.kind === 'completed') onCompleted();
              if (event.kind === 'phase' && event.boundary === 'end')
                onPhaseEnd();
            }),
          );
      const fiber = Effect.runFork(operation);
      await vi.waitFor(() => {
        expect(requestSignal).toBeDefined();
        if (!waitingForHeaders) {
          if (estimating || (complete && !malformed))
            expect(body.locked).toBe(true);
          else if (complete) expect(cancel).toHaveBeenCalledTimes(1);
          else expect(onDelta).toHaveBeenCalledTimes(1);
        }
      });

      if (!malformed) await Effect.runPromise(Fiber.interrupt(fiber));
      if (
        malformed ||
        phase === 'interruption-and-cancel' ||
        phase === 'estimate-interruption-and-cancel' ||
        phase === 'complete-interruption-and-cancel'
      ) {
        const exit = await Effect.runPromise(Fiber.await(fiber));
        assert(Exit.isFailure(exit));
        const defect = exit.cause.reasons.find(Cause.isDieReason);
        expect(defect?.defect).toBe(cancellation);
        if (malformed) {
          expect(exit.cause.reasons.map((reason) => reason._tag)).toContain(
            'Fail',
          );
          const primary = exit.cause.reasons.find(Cause.isFailReason);
          expect(primary?.error).toMatchObject({ kind: 'malformed-output' });
        } else {
          expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
        }
      }

      expect(requestSignal?.aborted).toBe(true);
      if (!waitingForHeaders) {
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(cancelledAfterAbort).toBe(true);
      }
      expect(body.locked).toBe(false);
      expect(onCompleted).not.toHaveBeenCalled();
      if (phase !== 'tool arguments') expect(onPhaseEnd).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
