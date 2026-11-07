// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Result, Schema } from 'effect';
import OpenAI from 'openai';

// Local imports - canonical model contract
import {
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnRequest,
} from '../turn.js';
import { boundTurn, resolveTurn } from './turnInput.js';
import { ModelError } from '../errors.js';
import { responseInput, toolNamespaceOf } from './openaiResponsesLower.js';
import type { ResponseOrigin } from './openaiResponsesCodec.js';
import type { UploadCache } from './uploadCache.js';
import type { ModelCredential, SessionToken } from '../node.js';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';

type ResponsesTransport = Extract<
  ResolvedTurn,
  { protocol: 'openai-responses'; mode: 'foreground' }
>['transport'];

/** Resolves controls before admission; a route with no output limit
 *  ignores the request's, and the lowering refuses a continuation on a
 *  route that does not store. No transport request is made here. */
export const prepareResponsesTurn = (
  config: OpenAIResponsesConfiguration,
  origin: ResponseOrigin,
  transport: ResponsesTransport,
  request: TurnRequest,
  uploads: UploadCache | null,
  background: Model['background'],
): Effect.Effect<ResolvedTurn, ModelError> =>
  resolveTurn(
    request,
    origin,
    background,
    (author) =>
      Effect.succeed({
        transport,
        controls: {
          temperature: config.defaults.temperature,
          maxOutputTokens:
            config.defaults.maxOutputTokens === null
              ? null
              : (author.maxOutputTokens ?? config.defaults.maxOutputTokens),
          store: config.defaults.store,
          reasoning: config.defaults.reasoning,
          serviceTier: config.defaults.serviceTier,
          ...(config.openaiEndpoint && author.cacheKey !== undefined
            ? { promptCacheKey: author.cacheKey }
            : {}),
        },
      }),
    (turn) =>
      responseParameters(config, origin, transport, turn, turn.mode, uploads),
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
    const turn = yield* boundTurn(input, origin, mode);
    if (
      !isDeepStrictEqual(turn.transport, transport) ||
      (config.defaults.temperature === null &&
        turn.controls.temperature !== null) ||
      (config.defaults.maxOutputTokens === null &&
        turn.controls.maxOutputTokens !== null) ||
      (!turn.controls.store && turn.continuation !== undefined) ||
      (turn.controls.reasoning?.effort != null &&
        !config.allowedReasoningEfforts.includes(
          turn.controls.reasoning.effort,
        )) ||
      (turn.controls.toolChoice !== 'auto' && !config.supportsForcedToolChoice)
    )
      return yield* new ModelError({
        kind: 'invalid-request',
        message:
          'The prepared transport or controls are unsupported by the selected route.',
      });
    const wireInput = yield* responseInput(turn, config, uploads);
    const reasoning = turn.controls.reasoning;
    // A compatible route sends `store` only to ask for storage it defaults off.
    let storage: Pick<ResponseCreateParamsBase, 'store' | 'include'> = {};
    if (config.requestDialect !== 'compatible') {
      storage = {
        store: turn.controls.store,
        include: ['reasoning.encrypted_content'],
      };
    } else if (turn.controls.store) {
      storage = { store: true };
    }
    const parameters: ResponseCreateParamsBase = {
      model: turn.requestedModel,
      ...wireInput,
      ...(turn.system !== undefined &&
      !(
        config.continuationInheritsInstructions &&
        wireInput.previous_response_id !== undefined
      )
        ? { instructions: turn.system }
        : {}),
      ...(turn.controls.maxOutputTokens !== null
        ? { max_output_tokens: turn.controls.maxOutputTokens }
        : {}),
      ...storage,
      ...(turn.controls.temperature !== null
        ? { temperature: turn.controls.temperature }
        : {}),
      ...(turn.controls.serviceTier !== null
        ? { service_tier: turn.controls.serviceTier }
        : {}),
      ...(turn.controls.promptCacheKey !== undefined
        ? { prompt_cache_key: turn.controls.promptCacheKey }
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
            tools: groupedTools(
              toolNamespaceOf(config),
              turn.tools.map((tool): OpenAI.Responses.FunctionTool => {
                if (config.requestDialect !== 'compatible')
                  return { type: 'function', ...tool, strict: false };
                const vendorTool: Omit<
                  OpenAI.Responses.FunctionTool,
                  'strict'
                > = { type: 'function', ...tool };
                // The vendor endpoints take no `strict`, which the OpenAI
                // typings require; the SDK sends the body as written.
                // cast: a FunctionTool without `strict`.
                return vendorTool as OpenAI.Responses.FunctionTool;
              }),
            ),
            // OpenAI's default, stated so a compatible endpoint takes it too.
            parallel_tool_calls: true,
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

/** The function tools, inside the route's one namespace when it requires one. */
const groupedTools = (
  namespace: string | null,
  tools: OpenAI.Responses.FunctionTool[],
): OpenAI.Responses.Tool[] =>
  namespace === null
    ? tools
    : [
        {
          type: 'namespace',
          name: namespace,
          description: 'The tools this agent can call.',
          tools,
        },
      ];

/** OpenAI's abort signature: the raw abort reason, or the SDK's wrapper around it. */
export const openaiAbortMatch = (
  cause: unknown,
  signal: AbortSignal,
): boolean =>
  cause === signal.reason ||
  (cause instanceof OpenAI.APIUserAbortError && cause.cause === signal.reason);

/** A bearer token, as a header value takes one. */
const BearerTokenSchema = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.isPattern(/^[^\r\n]+$/),
);

/** The token `bearer` holds now, checked as a header value. */
const tokenOf = (bearer: string | SessionToken) =>
  (typeof bearer === 'string' ? Effect.succeed(bearer) : bearer.current).pipe(
    Effect.flatMap((token) =>
      Effect.mapError(
        Schema.decodeUnknownEffect(BearerTokenSchema)(token),
        () =>
          new ModelError({
            kind: 'invalid-request',
            message: 'The Responses credential is not a single-line token.',
          }),
      ),
    ),
  );

/** The bearer a Responses credential sends. */
export const bearerOf = (credential: ModelCredential): string | SessionToken =>
  credential.kind === 'api-key' ? credential.apiKey : credential.accessToken;

/**
 * Send `request` with `bearer`'s token. A session token the provider
 * rejects is handed back once and the request sent again on the next one;
 * the rejected request was not billed, and a second rejection stands.
 */
export const authorized = <A, R>(
  bearer: string | SessionToken,
  request: (token: string) => Effect.Effect<A, ModelError, R>,
): Effect.Effect<A, ModelError, R> =>
  Effect.gen(function* () {
    const token = yield* tokenOf(bearer);
    if (typeof bearer === 'string') return yield* request(token);
    const first = yield* Effect.result(request(token));
    if (Result.isSuccess(first)) return first.success;
    if (first.failure.kind !== 'authentication')
      return yield* Effect.fail(first.failure);
    yield* bearer.rejected(token);
    return yield* request(yield* tokenOf(bearer));
  });

/** The `Authorization` header a request sends `token` in. */
export const bearerHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
});

/** Ambient OpenAI headers would override the selected deployment. */
export function refuseAmbientHeaders(): void {
  if (process.env.OPENAI_CUSTOM_HEADERS)
    throw new ModelError({
      kind: 'invalid-request',
      message:
        'Ambient OpenAI headers cannot override the selected deployment.',
    });
}

/**
 * The SDK client for one selected Responses deployment: no retries, no
 * ambient organization. A request names its token in its own headers
 * (`bearerHeaders`); the client's key is a fixed key's, for the Files API,
 * which only a fixed key reaches.
 */
export const openaiClient = (
  endpoint: string,
  bearer: string | SessionToken,
  fetch?: typeof globalThis.fetch,
) =>
  new OpenAI({
    // A session's requests each carry their token; this one is never sent.
    apiKey: typeof bearer === 'string' ? bearer : 'per-request',
    baseURL: endpoint,
    fetch,
    maxRetries: 0,
    organization: null,
    project: null,
    logLevel: 'off',
  });
