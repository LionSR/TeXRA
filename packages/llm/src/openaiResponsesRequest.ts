// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect } from 'effect';
import OpenAI from 'openai';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  InputTokenEstimateSchema,
  ResolvedTurnSchema,
  TurnRequestSchema,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnRequest,
} from './turn.js';
import { sameModelOrigin } from './protocol.js';
import { ModelError, enrichModelError } from './errors.js';
import { ownedAbortSafeRequest } from './transport.js';
import { openaiFailure } from './openaiError.js';
import { responseInput } from './openaiResponsesLower.js';
import type { ResponseOrigin } from './openaiResponsesCodec.js';
import type { UploadCache } from './uploadCache.js';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';

type ResponsesTransport = Extract<
  ResolvedTurn,
  { protocol: 'openai-responses'; mode: 'foreground' }
>['transport'];

/** Resolves controls before admission; no transport request is made here. */
export const prepareResponsesTurn = Effect.fn('llm.responses.prepareTurn')(
  function* (
    config: OpenAIResponsesConfiguration,
    origin: ResponseOrigin,
    transport: ResponsesTransport,
    request: TurnRequest,
    uploads: UploadCache | null,
  ) {
    const parsed = TurnRequestSchema.safeParse(request);
    if (!parsed.success)
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'The model input is invalid.',
        cause: parsed.error,
      });
    const author = parsed.data;
    if (
      author.thinkingLevel !== undefined ||
      author.thinking !== undefined ||
      author.effort !== undefined ||
      author.cache !== undefined ||
      author.stopSequences !== undefined ||
      (author.continuation !== undefined &&
        author.continuation.origin.protocol !== 'openai-responses') ||
      (author.mode === 'background' &&
        (config.background !== 'supported' || transport.kind !== 'http')) ||
      (!config.supportsTemperature && author.temperature !== undefined) ||
      (!config.supportsMaxOutputTokens &&
        author.maxOutputTokens !== undefined) ||
      (!config.supportsStorage && author.store === true)
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The model does not support the requested controls or continuation.',
      });
    }
    const turn = ResolvedTurnSchema.parse({
      ...origin,
      mode: author.mode ?? 'foreground',
      transport,
      system:
        config.instructions.kind === 'required'
          ? author.system?.trim() || config.instructions.fallback
          : author.system,
      messages: author.messages,
      tools: author.tools ?? [],
      continuation: author.continuation,
      controls: {
        temperature: config.supportsTemperature
          ? (author.temperature ?? config.defaults.temperature)
          : null,
        maxOutputTokens:
          author.maxOutputTokens ?? config.defaults.maxOutputTokens,
        store: author.store ?? config.defaults.store,
        parallelToolCalls:
          author.parallelToolCalls ?? config.defaults.parallelToolCalls,
        toolChoice: author.toolChoice ?? 'auto',
        reasoning:
          author.reasoning === undefined
            ? config.defaults.reasoning
            : author.reasoning,
        serviceTier:
          author.serviceTier === undefined
            ? config.defaults.serviceTier
            : author.serviceTier,
      },
    });
    if (turn.protocol !== 'openai-responses')
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The prepared protocol changed.',
      });
    yield* responseParameters(
      config,
      origin,
      transport,
      turn,
      turn.mode,
      uploads,
    );
    return turn;
  },
);

/** Validates the admitted binding and lowers one request without transport flags. */
export const responseParameters = Effect.fn('llm.responses.parameters')(
  function* (
    config: OpenAIResponsesConfiguration,
    origin: ResponseOrigin,
    transport: ResponsesTransport,
    input: ResolvedTurn,
    mode: 'foreground' | 'background',
    uploads: UploadCache | null,
  ) {
    const parsed = ResolvedTurnSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.protocol !== 'openai-responses' ||
      parsed.data.mode !== mode ||
      !isDeepStrictEqual(parsed.data.transport, transport) ||
      !sameModelOrigin(parsed.data, origin) ||
      (mode === 'background' && config.background !== 'supported')
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The prepared invocation belongs to another model, protocol or execution mode.',
      });
    }
    const turn = parsed.data;
    if (
      (!config.supportsTemperature && turn.controls.temperature !== null) ||
      (!config.supportsMaxOutputTokens &&
        turn.controls.maxOutputTokens !== null) ||
      (!config.supportsStorage && turn.controls.store) ||
      (config.instructions.kind === 'required' && !turn.system?.trim()) ||
      (turn.controls.reasoning?.effort != null &&
        !config.allowedReasoningEfforts.includes(
          turn.controls.reasoning.effort,
        )) ||
      (turn.continuation !== undefined && !config.supportsResponseChaining)
    )
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The prepared controls are unsupported by the selected route.',
      });
    const wireInput = yield* responseInput(turn, config, uploads);
    const reasoning = turn.controls.reasoning;
    const parameters: ResponseCreateParamsBase = {
      model: turn.requestedModel,
      ...wireInput,
      ...(turn.system !== undefined ? { instructions: turn.system } : {}),
      ...(turn.controls.maxOutputTokens !== null
        ? { max_output_tokens: turn.controls.maxOutputTokens }
        : {}),
      store: turn.controls.store,
      include: ['reasoning.encrypted_content'],
      ...(turn.controls.temperature !== null
        ? { temperature: turn.controls.temperature }
        : {}),
      ...(turn.controls.serviceTier !== null
        ? { service_tier: turn.controls.serviceTier }
        : {}),
      ...(reasoning !== null
        ? {
            reasoning: {
              ...(reasoning.effort !== null
                ? { effort: reasoning.effort }
                : {}),
              ...(reasoning.mode !== null ? { mode: reasoning.mode } : {}),
              ...(reasoning.summary !== null
                ? { summary: reasoning.summary }
                : {}),
            },
          }
        : {}),
      ...(turn.tools.length > 0
        ? {
            tools: turn.tools.map((tool) => ({
              type: 'function' as const,
              ...tool,
              strict: false,
            })),
            parallel_tool_calls: turn.controls.parallelToolCalls,
            tool_choice:
              turn.controls.toolChoice === 'auto'
                ? ('auto' as const)
                : {
                    type: 'function' as const,
                    name: turn.controls.toolChoice.name,
                  },
          }
        : {}),
    };
    return { turn, parameters };
  },
);

/** OpenAI's abort signature: the raw abort reason, or the SDK's wrapper around it. */
export const openaiAbortMatch = (
  cause: unknown,
  signal: AbortSignal,
): boolean =>
  cause === signal.reason ||
  (cause instanceof OpenAI.APIUserAbortError && cause.cause === signal.reason);

/** Counts only the initial text input; the caller owns admission and retry policy. */
export const estimateResponseInput = Effect.fn(
  'llm.responses.estimateInputTokens',
)(function* (
  config: OpenAIResponsesConfiguration,
  origin: ResponseOrigin,
  transport: ResponsesTransport,
  client: OpenAI,
  input: Extract<ResolvedTurn, { mode: 'foreground' }>,
) {
  // Estimation admits a single text message, so no file id can apply.
  const { turn, parameters } = yield* responseParameters(
    config,
    origin,
    transport,
    input,
    'foreground',
    null,
  );
  if (
    turn.continuation !== undefined ||
    turn.tools.length !== 0 ||
    turn.messages.length !== 1 ||
    turn.messages[0]?.role !== 'user' ||
    turn.messages[0].content.some((part) => part.kind !== 'text')
  )
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'Input estimation supports one initial text-only user message without tools or continuation.',
    });

  let requestId: string | undefined;
  const enrich = (error: ModelError) =>
    enrichModelError(error, {
      requestId: error.requestId ?? requestId,
      model: error.model ?? origin.requestedModel,
    });
  const raw = yield* ownedAbortSafeRequest(
    (signal) =>
      client.responses.inputTokens
        .count(
          {
            model: parameters.model,
            input: parameters.input,
            ...(parameters.instructions !== undefined
              ? { instructions: parameters.instructions }
              : {}),
            ...(parameters.reasoning !== undefined
              ? { reasoning: parameters.reasoning }
              : {}),
          },
          { signal, maxRetries: 0 },
        )
        .asResponse()
        .then((response) => {
          requestId = response.headers.get('x-request-id') ?? undefined;
          return response.json() as Promise<unknown>;
        }),
    (cause) =>
      enrich(
        cause instanceof SyntaxError
          ? new ModelError({
              kind: 'malformed-output',
              message: 'The input token count returned malformed JSON.',
              cause,
            })
          : openaiFailure(cause),
      ),
    {
      isAbortMatch: openaiAbortMatch,
      cleanupFailure: (cause) =>
        enrich(
          new ModelError({
            kind: 'transport',
            message: 'The input token count failed while joining its request.',
            cause,
          }),
        ),
    },
  );
  const parsed = z
    .object({
      object: z.literal('response.input_tokens'),
      input_tokens: InputTokenEstimateSchema.unwrap().shape.inputTokens,
    })
    .safeParse(raw);
  if (!parsed.success)
    return yield* enrich(
      new ModelError({
        kind: 'malformed-output',
        message: 'The input token count returned an invalid receipt.',
        cause: parsed.error,
      }),
    );
  return InputTokenEstimateSchema.parse({
    inputTokens: parsed.data.input_tokens,
    coverage: 'responses-input',
  });
});

export const ResponseAuthenticationSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('api-key'),
      apiKey: z
        .string()
        .min(1)
        .regex(/^[^\r\n]+$/),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('codex'),
      accessToken: z
        .string()
        .min(1)
        .regex(/^[^\r\n]+$/),
      accountId: z
        .string()
        .min(1)
        .regex(/^[^\r\n]+$/)
        .nullable(),
    })
    .readonly(),
]);

/** Secrets are captured together and never become prepared request controls. */
export function responseAuthentication(
  input: z.infer<typeof ResponseAuthenticationSchema>,
) {
  if (process.env.OPENAI_CUSTOM_HEADERS)
    throw new ModelError({
      kind: 'unsupported',
      message:
        'Ambient OpenAI headers cannot override the selected deployment.',
    });
  const authentication = ResponseAuthenticationSchema.parse(input);
  return authentication.kind === 'api-key'
    ? { token: authentication.apiKey, headers: {} }
    : {
        token: authentication.accessToken,
        headers: {
          ...(authentication.accountId !== null
            ? { 'chatgpt-account-id': authentication.accountId }
            : {}),
          originator: 'texra',
          'openai-beta': 'responses=experimental',
        },
      };
}
