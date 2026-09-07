// Node.js imports
import assert from 'node:assert/strict';

// Third-party imports
import { openaiChatModel } from '@texra-ai/llm/openai-chat';
import {
  ModelError,
  type ChatConfiguration,
  type Model,
  type TurnRequest,
} from '@texra-ai/llm/turn';
import { Cause, Effect, Exit, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CONFIG = {
  protocol: 'openai-chat' as const,
  requestedModel: 'synthetic-model',
  deployment: {
    endpoint: 'https://synthetic.invalid/v1',
    credentialScope: 'synthetic-account',
  },
  defaults: { temperature: 0, maxOutputTokens: 100, parallelToolCalls: true },
};
const REQUEST: TurnRequest = {
  messages: [
    { role: 'user', content: [{ kind: 'text', text: 'Generate YAML.' }] },
  ],
};
const REASONING_CONFIGS = [
  {
    ...CONFIG,
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
    ...CONFIG,
    protocol: 'kimi-chat',
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
    ...CONFIG,
    protocol: 'glm-chat',
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
  it.each([
    { present: true, fragmented: false },
    { present: true, fragmented: true },
    { present: false, fragmented: true },
  ])(
    'requires the Kimi terminal sentinel (present: $present; fragmented: $fragmented)',
    async ({ present, fragmented }) => {
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
      const model = openaiChatModel(REASONING_CONFIGS[1], {
        apiKey: 'synthetic',
        fetch,
      });
      if (present) {
        const result = await Effect.runPromise(generate(model));
        expect(result.finishReason).toBe('stop');
        expect(result.content).toEqual([
          { kind: 'message', content: [{ kind: 'text', text: 'x² 🙂' }] },
        ]);
      } else {
        const failure = await Effect.runPromise(Effect.flip(generate(model)));
        expect(failure).toMatchObject({
          kind: 'malformed-output',
          responseId: 'synthetic-response',
        });
      }
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
  ])(
    'does not complete after $name',
    async ({ config, root, choice, delta, finish, kind }) => {
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
                  finish_reason: finish ?? 'stop',
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
    { config: REASONING_CONFIGS[0], controls: { temperature: 1 } },
    { config: REASONING_CONFIGS[1], controls: { temperature: 1 } },
    {
      config: REASONING_CONFIGS[2],
      controls: { thinking: { mode: 'disabled' }, effort: null },
    },
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
      expect(events.filter((event) => event.kind === 'delta')).toEqual([
        { kind: 'delta', part: 'reasoning', text: fragments[1] },
        { kind: 'delta', part: 'reasoning', text: fragments[2] },
        { kind: 'delta', part: 'text', text: 'Checking.' },
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
      const final = await Effect.runPromise(
        model.generateTurn(JSON.parse(JSON.stringify(followUp))),
      );
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
          chunk(),
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
      { kind: 'delta', part: 'text', text: 'generated: true' },
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
              content: [{ kind: 'text', text: 'generated: true' }],
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
    assert(prepared.mode === 'foreground');
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
    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe('identified');
    expect(events[1]).toEqual({
      kind: 'delta',
      part: 'text',
      text: 'Checking.',
    });
    const completed = events[2];
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

  it('freezes configured parallelism and the required tool before sending', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        response(sse(toolChunk([call(0)], 'tool_calls'))),
      );
    const config = structuredClone(CONFIG);
    config.defaults.parallelToolCalls = false;
    const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
    const choice = { name: 'search' };
    const turn = await Effect.runPromise(
      model.prepareTurn({ ...REQUEST, tools: TOOLS, toolChoice: choice }),
    );
    assert(turn.mode === 'foreground');
    config.defaults.parallelToolCalls = true;
    choice.name = 'fetch';
    await Effect.runPromise(model.generateTurn(turn));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      parallel_tool_calls: false,
      tool_choice: { type: 'function', function: { name: 'search' } },
    });
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
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'user media',
    'tool media',
    'reasoning',
    'missing call ID',
    'text after calls',
    'reasoning control',
    'service-tier control',
    'background mode',
    'thinking control',
    'effort control',
    'cache control',
    'stop control',
    'inference geography',
    'Responses message evidence',
    'Responses call evidence',
  ] as const)('rejects unsupported %s before transport', async (scenario) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = modelWith(fetch);
    const image = { kind: 'image', mimeType: 'image/png', base64: '' } as const;
    const content: TurnRequest['messages'][number] = {
      role: 'assistant',
      origin: {
        protocol: 'openai-chat',
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
    };
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
              content:
                scenario === 'tool media'
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
    if (scenario === 'effort control') request = { ...REQUEST, effort: null };
    if (scenario === 'cache control')
      request = { ...REQUEST, cache: 'disabled' };
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
                origin: { ...message.origin, protocol: 'openai-responses' },
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
      const failure = await Effect.runPromise(
        Effect.flip(generate(modelWith(fetch))),
      );
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

  it('preserves a body-read failure and the HTTP request identity after reasoning', async () => {
    const cause = new Error('Original body failure');
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(current) {
        controller = current;
        current.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(
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
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_input, init) => {
        requestSignal = init?.signal;
        return new Response(body, {
          headers: {
            'content-type': 'text/event-stream',
            'x-request-id': 'http-original-request',
          },
        });
      });
    const model = openaiChatModel(REASONING_CONFIGS[2], {
      apiKey: 'synthetic',
      fetch,
    });
    const prepared = await Effect.runPromise(model.prepareTurn(REQUEST));
    assert(prepared.mode === 'foreground');
    const failure = await Effect.runPromise(
      Effect.flip(
        Stream.runForEach(model.streamTurn(prepared), (event) =>
          Effect.sync(() => {
            if (event.kind === 'delta') controller.error(cause);
          }),
        ),
      ),
    );
    expect(failure).toMatchObject({
      kind: 'transport',
      responseId: 'synthetic-response',
      model: 'returned-model-version',
      requestId: 'http-original-request',
    });
    expect(failure.cause).toBe(cause);
    expect(requestSignal?.aborted).toBe(true);
    expect(body.locked).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'headers',
    'body',
    'tool arguments',
    'reasoning',
    'successful-take',
    'malformed-frame-and-cancel',
    'interruption-and-cancel',
  ] as const)(
    'interrupts a pending %s read and joins cleanup',
    async (phase) => {
      let requestSignal: AbortSignal | null | undefined;
      let cancelledAfterAbort = false;
      const cancellation = new Error('Cancellation failed');
      const cancel = vi.fn(() => {
        cancelledAfterAbort = requestSignal?.aborted ?? false;
        if (
          phase === 'successful-take' ||
          phase === 'malformed-frame-and-cancel' ||
          phase === 'interruption-and-cancel'
        )
          throw cancellation;
      });
      const onDelta = vi.fn();
      const onCompleted = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: phase === 'reasoning' ? { reasoning_content: 'partial' } : { content: 'partial' }, finish_reason: null }] }))}\n\n`,
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
        },
        cancel,
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation((_input, init) => {
          requestSignal = init?.signal;
          if (phase !== 'headers')
            return Promise.resolve(
              new Response(body, {
                headers: { 'content-type': 'text/event-stream' },
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
      const model =
        phase === 'reasoning'
          ? openaiChatModel(REASONING_CONFIGS[0], {
              apiKey: 'synthetic',
              fetch,
            })
          : modelWith(fetch);
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
      const fiber = Effect.runFork(
        Stream.runForEach(model.streamTurn(prepared), (event) =>
          Effect.sync(() => {
            if (event.kind === 'delta') onDelta();
            if (event.kind === 'completed') onCompleted();
          }),
        ),
      );
      await vi.waitFor(() => {
        expect(requestSignal).toBeDefined();
        if (phase !== 'headers') expect(onDelta).toHaveBeenCalledTimes(1);
      });

      if (phase !== 'malformed-frame-and-cancel')
        await Effect.runPromise(Fiber.interrupt(fiber));
      if (
        phase === 'malformed-frame-and-cancel' ||
        phase === 'interruption-and-cancel'
      ) {
        const exit = await Effect.runPromise(Fiber.await(fiber));
        assert(Exit.isFailure(exit));
        const defect = exit.cause.reasons.find(Cause.isDieReason);
        expect(defect?.defect).toBe(cancellation);
        if (phase === 'malformed-frame-and-cancel') {
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
      if (phase !== 'headers') {
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(cancelledAfterAbort).toBe(true);
      }
      expect(body.locked).toBe(false);
      expect(onCompleted).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
