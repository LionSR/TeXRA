// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Schema } from 'effect';
import OpenAI from 'openai';

// Local imports - canonical model contract
import {
  ResolvedTurnSchema,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnRequest,
} from '../turn.js';
import { decodeTurnRequest } from './turnInput.js';
import { sameModelOrigin } from '../protocol.js';
import { ModelError } from '../errors.js';
import { responseInput } from './openaiResponsesLower.js';
import { openaiFailure } from './openaiError.js';
import type { ResponseOrigin } from './openaiResponsesCodec.js';
import type { UploadCache } from './uploadCache.js';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';

type ResponsesTransport = Extract<
  ResolvedTurn,
  { protocol: 'openai-responses'; mode: 'foreground' }
>['transport'];
type ResponsesTurn = Extract<ResolvedTurn, { protocol: 'openai-responses' }>;

/**
 * Whether the authored request asks for what the route cannot do: a foreign
 * continuation, background work off HTTP or on a route without it, an output
 * limit or storage the route does not take.
 */
const refusesRequest = (
  config: OpenAIResponsesConfiguration,
  transport: ResponsesTransport,
  author: TurnRequest,
): boolean =>
  (author.continuation !== undefined &&
    author.continuation.origin.protocol !== 'openai-responses') ||
  (author.mode === 'background' &&
    (config.background !== 'supported' || transport.kind !== 'http')) ||
  (!config.supportsMaxOutputTokens && author.maxOutputTokens !== undefined) ||
  (!config.supportsStorage && author.store === true);

/** Resolves controls before admission; no transport request is made here. */
export const prepareResponsesTurn = Effect.fn('llm.responses.prepareTurn')(
  function* (
    config: OpenAIResponsesConfiguration,
    origin: ResponseOrigin,
    transport: ResponsesTransport,
    request: TurnRequest,
    uploads: UploadCache | null,
  ) {
    const author = yield* decodeTurnRequest(
      request,
      'The model input is invalid.',
    );
    if (refusesRequest(config, transport, author)) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The model does not support the requested controls or continuation.',
      });
    }
    const turn = Schema.decodeUnknownSync(ResolvedTurnSchema)({
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
          ? config.defaults.temperature
          : null,
        maxOutputTokens:
          author.maxOutputTokens ?? config.defaults.maxOutputTokens,
        store: author.store ?? config.defaults.store,
        parallelToolCalls: config.defaults.parallelToolCalls,
        toolChoice: author.toolChoice ?? 'auto',
        reasoning: config.defaults.reasoning,
        serviceTier: config.defaults.serviceTier,
        ...(config.openaiEndpoint && author.cacheKey !== undefined
          ? { promptCacheKey: author.cacheKey }
          : {}),
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

/**
 * Whether the prepared controls ask for what the selected route does not
 * take: sampling, an output limit, storage or chaining, instructions it
 * requires, a reasoning effort or a forced tool.
 */
const refusesControls = (
  config: OpenAIResponsesConfiguration,
  turn: ResponsesTurn,
): boolean =>
  (!config.supportsTemperature && turn.controls.temperature !== null) ||
  (!config.supportsMaxOutputTokens && turn.controls.maxOutputTokens !== null) ||
  (!config.supportsStorage &&
    (turn.controls.store || turn.continuation !== undefined)) ||
  (config.instructions.kind === 'required' && !turn.system?.trim()) ||
  (turn.controls.reasoning?.effort != null &&
    !config.allowedReasoningEfforts.includes(turn.controls.reasoning.effort)) ||
  (turn.controls.toolChoice !== 'auto' && !config.supportsForcedToolChoice);

/** The reasoning controls as the request's `reasoning`, naming only what is set. */
function wireReasoning(
  reasoning: NonNullable<ResponsesTurn['controls']['reasoning']>,
): NonNullable<ResponseCreateParamsBase['reasoning']> {
  return {
    ...(reasoning.effort !== null ? { effort: reasoning.effort } : {}),
    ...(reasoning.mode !== null ? { mode: reasoning.mode } : {}),
    ...(reasoning.summary !== null ? { summary: reasoning.summary } : {}),
  };
}

/** The turn's tools, their parallelism and the tool choice, when it has tools. */
function wireTools(
  config: OpenAIResponsesConfiguration,
  turn: ResponsesTurn,
): Pick<
  ResponseCreateParamsBase,
  'tools' | 'parallel_tool_calls' | 'tool_choice'
> {
  if (turn.tools.length === 0) return {};
  return {
    tools: turn.tools.map((tool): OpenAI.Responses.FunctionTool => {
      if (config.requestDialect === 'openai')
        return { type: 'function', ...tool, strict: false };
      const vendorTool: Omit<OpenAI.Responses.FunctionTool, 'strict'> = {
        type: 'function',
        ...tool,
      };
      // cast: the vendor endpoints take no `strict`, which the OpenAI typings require.
      return vendorTool as OpenAI.Responses.FunctionTool;
    }),
    parallel_tool_calls: turn.controls.parallelToolCalls,
    tool_choice:
      turn.controls.toolChoice === 'auto'
        ? 'auto'
        : { type: 'function', name: turn.controls.toolChoice.name },
  };
}

/**
 * The request parameters for the lowered input: the route's dialect decides
 * storage, and each control is sent only when set.
 */
function requestParameters(
  config: OpenAIResponsesConfiguration,
  turn: ResponsesTurn,
  wireInput: Pick<ResponseCreateParamsBase, 'input' | 'previous_response_id'>,
): ResponseCreateParamsBase {
  const { controls } = turn;
  // A compatible route sends `store` only to ask for storage it defaults off.
  let storage: Pick<ResponseCreateParamsBase, 'store' | 'include'> = {};
  if (config.requestDialect === 'openai') {
    storage = {
      store: controls.store,
      include: ['reasoning.encrypted_content'],
    };
  } else if (controls.store) {
    storage = { store: true };
  }
  return {
    model: turn.requestedModel,
    ...wireInput,
    ...(turn.system !== undefined &&
    !(
      config.continuationInheritsInstructions &&
      wireInput.previous_response_id !== undefined
    )
      ? { instructions: turn.system }
      : {}),
    ...(controls.maxOutputTokens !== null
      ? { max_output_tokens: controls.maxOutputTokens }
      : {}),
    ...storage,
    ...(controls.temperature !== null
      ? { temperature: controls.temperature }
      : {}),
    ...(controls.serviceTier !== null
      ? { service_tier: controls.serviceTier }
      : {}),
    ...(controls.promptCacheKey !== undefined
      ? { prompt_cache_key: controls.promptCacheKey }
      : {}),
    ...(controls.reasoning !== null
      ? { reasoning: wireReasoning(controls.reasoning) }
      : {}),
    ...wireTools(config, turn),
  };
}

/** Validates the admitted binding and lowers one request without transport flags. */
export const responseParameters = Effect.fn('llm.responses.parameters')(
  function* (
    config: OpenAIResponsesConfiguration,
    origin: ResponseOrigin,
    transport: ResponsesTransport,
    turn: ResolvedTurn,
    mode: 'foreground' | 'background',
    uploads: UploadCache | null,
  ) {
    if (
      turn.protocol !== 'openai-responses' ||
      turn.mode !== mode ||
      !isDeepStrictEqual(turn.transport, transport) ||
      !sameModelOrigin(turn, origin) ||
      (mode === 'background' && config.background !== 'supported')
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The prepared invocation belongs to another model, protocol or execution mode.',
      });
    }
    if (refusesControls(config, turn))
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The prepared controls are unsupported by the selected route.',
      });
    const wireInput = yield* responseInput(turn, config, uploads);
    return { turn, parameters: requestParameters(config, turn, wireInput) };
  },
);

/** OpenAI's abort signature: the raw abort reason, or the SDK's wrapper around it. */
export const openaiAbortMatch = (
  cause: unknown,
  signal: AbortSignal,
): boolean =>
  cause === signal.reason ||
  (cause instanceof OpenAI.APIUserAbortError && cause.cause === signal.reason);

/**
 * The credential a Responses binding is built with: an API key, or a Codex
 * subscription's access token with the account it bills. Neither may hold a
 * line break, since each travels in a request header.
 */
export const ResponseAuthenticationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('api-key'),
    apiKey: Schema.String.check(Schema.isMinLength(1)).check(
      Schema.isPattern(/^[^\r\n]+$/),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal('codex'),
    accessToken: Schema.String.check(Schema.isMinLength(1)).check(
      Schema.isPattern(/^[^\r\n]+$/),
    ),
    accountId: Schema.NullOr(
      Schema.String.check(Schema.isMinLength(1)).check(
        Schema.isPattern(/^[^\r\n]+$/),
      ),
    ),
  }),
]);

/** The bearer token and the extra headers every request of a binding sends. */
interface ResponseCredentials {
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Secrets are captured together and never become prepared request controls. */
export function responseAuthentication(
  input: typeof ResponseAuthenticationSchema.Type,
): ResponseCredentials {
  if (process.env.OPENAI_CUSTOM_HEADERS)
    throw new ModelError({
      kind: 'unsupported',
      message:
        'Ambient OpenAI headers cannot override the selected deployment.',
    });
  const authentication = Schema.decodeUnknownSync(ResponseAuthenticationSchema)(
    input,
  );
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

/** The SDK client for one selected Responses deployment: no retries, no ambient organization. */
export const openaiClient = (
  endpoint: string,
  authentication: ResponseCredentials,
  fetch?: typeof globalThis.fetch,
): OpenAI =>
  new OpenAI({
    apiKey: authentication.token,
    defaultHeaders: authentication.headers,
    baseURL: endpoint,
    fetch,
    maxRetries: 0,
    organization: null,
    project: null,
    logLevel: 'off',
  });

/** One bound HTTP Responses deployment: its route, origin, client and uploads. */
export interface ResponsesBinding {
  readonly config: OpenAIResponsesConfiguration;
  readonly origin: Extract<ResponseOrigin, { protocol: 'openai-responses' }>;
  readonly client: OpenAI;
  /** The Files API cache, on an API-key binding only. */
  readonly uploads: UploadCache | null;
}

/** Lowers one prepared turn and opens its streamed HTTP response. */
export const createResponse = Effect.fn('llm.responses.create')(function* (
  { config, origin, client, uploads }: ResponsesBinding,
  input: ResolvedTurn,
  mode: 'foreground' | 'background',
) {
  const { turn, parameters } = yield* responseParameters(
    config,
    origin,
    { kind: 'http' },
    input,
    mode,
    uploads,
  );
  const signal = yield* Effect.abortSignal;
  const opened = yield* Effect.tryPromise({
    try: () =>
      client.responses
        .create(
          {
            ...parameters,
            stream: true,
            ...(mode === 'background' ? { background: true } : {}),
          },
          { signal },
        )
        .withResponse(),
    catch: openaiFailure,
  });
  return { turn, opened };
});
