// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Schema } from 'effect';
import OpenAI from 'openai';

// Local imports - canonical model contract
import {
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnRequest,
} from '../turn.js';
import { resolveTurn } from './turnInput.js';
import { sameModelOrigin } from '../protocol.js';
import { ModelError } from '../errors.js';
import { responseInput, toolNamespaceOf } from './openaiResponsesLower.js';
import type { ResponseOrigin } from './openaiResponsesCodec.js';
import type { UploadCache } from './uploadCache.js';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';

type ResponsesTransport = Extract<
  ResolvedTurn,
  { protocol: 'openai-responses'; mode: 'foreground' }
>['transport'];

/** Resolves controls before admission; a route with no output limit
 *  ignores the request's, and the lowering refuses an unsupported storage
 *  request. No transport request is made here. */
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
        ...origin,
        mode: author.mode ?? 'foreground',
        transport,
        system: author.system,
        messages: author.messages,
        tools: author.tools ?? [],
        continuation: author.continuation,
        controls: {
          temperature: config.defaults.temperature,
          maxOutputTokens:
            config.defaults.maxOutputTokens === null
              ? null
              : (author.maxOutputTokens ?? config.defaults.maxOutputTokens),
          store: config.defaults.store,
          toolChoice: author.toolChoice ?? 'auto',
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
    turn: ResolvedTurn,
    mode: 'foreground' | 'background',
    uploads: UploadCache | null,
  ) {
    if (
      turn.protocol !== 'openai-responses' ||
      turn.mode !== mode ||
      !isDeepStrictEqual(turn.transport, transport) ||
      !sameModelOrigin(turn, origin)
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The prepared invocation belongs to another model, protocol or execution mode.',
      });
    }
    if (
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
        kind: 'unsupported',
        message: 'The prepared controls are unsupported by the selected route.',
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

export const ResponseAuthenticationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('api-key'),
    apiKey: Schema.String.check(Schema.isMinLength(1)).check(
      Schema.isPattern(/^[^\r\n]+$/),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal('chatgpt'),
    accessToken: Schema.String.check(Schema.isMinLength(1)).check(
      Schema.isPattern(/^[^\r\n]+$/),
    ),
  }),
]);

/** Secrets are captured together and never become prepared request controls. */
export function responseAuthentication(
  input: typeof ResponseAuthenticationSchema.Type,
) {
  if (process.env.OPENAI_CUSTOM_HEADERS)
    throw new ModelError({
      kind: 'unsupported',
      message:
        'Ambient OpenAI headers cannot override the selected deployment.',
    });
  const authentication = Schema.decodeUnknownSync(ResponseAuthenticationSchema)(
    input,
  );
  return {
    token:
      authentication.kind === 'api-key'
        ? authentication.apiKey
        : authentication.accessToken,
    headers: {},
  };
}

/** The SDK client for one selected Responses deployment: no retries, no ambient organization. */
export const openaiClient = (
  endpoint: string,
  authentication: ReturnType<typeof responseAuthentication>,
  fetch?: typeof globalThis.fetch,
) =>
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
