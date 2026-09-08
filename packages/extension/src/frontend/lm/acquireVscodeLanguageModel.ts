// Node imports
import { randomUUID } from 'node:crypto';

// Third-party imports
import {
  JsonObjectSchema,
  ModelConfigurationSchema,
  ModelError,
  ResolvedTurnSchema,
  TurnRequestSchema,
  TurnResultSchema,
  sameModelOrigin,
  type Model,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
  type VscodeLanguageModelConfiguration,
} from '@texra-ai/llm/turn';
import { Cause, Effect, Exit, Stream, type Scope } from 'effect';
import * as vscode from 'vscode';

type EditorOrigin = Extract<ModelOrigin, { protocol: 'vscode-lm' }>;
type EditorTurn = Extract<ResolvedTurn, { protocol: 'vscode-lm' }>;

function nativeFailure(cause: unknown, origin: EditorOrigin): ModelError {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? cause.code
      : undefined;
  const knownCode =
    code === 'NoPermissions' || code === 'Blocked' || code === 'NotFound'
      ? code
      : undefined;
  let kind: ModelError['kind'] = 'transport';
  if (knownCode === 'NoPermissions') kind = 'authentication';
  else if (knownCode === 'NotFound') kind = 'unsupported';
  else if (knownCode === 'Blocked') kind = 'provider-rejection';
  return new ModelError({
    kind,
    message:
      cause instanceof Error
        ? cause.message
        : 'The editor language-model operation failed.',
    model: origin.requestedModel,
    cause,
    ...(knownCode === undefined
      ? {}
      : {
          providerEvidence: { kind: 'vscode-lm', origin, code: knownCode },
        }),
  });
}

function lowerMessages(
  turn: EditorTurn,
  config: VscodeLanguageModelConfiguration,
): Effect.Effect<vscode.LanguageModelChatMessage[], ModelError> {
  return Effect.gen(function* () {
    if (turn.tools.length > 0 && !config.supportsToolCalling) {
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The selected editor model does not support tool calls.',
      });
    }
    const messages: vscode.LanguageModelChatMessage[] = [];
    for (const [index, message] of turn.messages.entries()) {
      if (message.role === 'assistant') {
        const content: Array<
          vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
        > = [];
        for (const part of message.content) {
          if (part.kind === 'message' && part.evidence === undefined) {
            for (const child of part.content) {
              if (child.kind !== 'text') {
                return yield* new ModelError({
                  kind: 'unsupported',
                  message: 'Editor models cannot replay refusal evidence.',
                });
              }
              content.push(new vscode.LanguageModelTextPart(child.text));
            }
          } else if (
            part.kind === 'local-call' &&
            part.evidence === undefined &&
            part.providerCallId !== null &&
            config.supportsToolCalling
          ) {
            content.push(
              new vscode.LanguageModelToolCallPart(
                part.providerCallId,
                part.name,
                part.arguments,
              ),
            );
          } else {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'The editor model cannot preserve this assistant content or its provider evidence.',
            });
          }
        }
        messages.push(vscode.LanguageModelChatMessage.Assistant(content));
      } else if (message.role === 'tool') {
        const assistant = turn.messages[index - 1];
        if (assistant?.role !== 'assistant') {
          return yield* new ModelError({
            kind: 'invalid-request',
            message: 'Tool results require their preceding assistant response.',
          });
        }
        const calls = assistant.content.filter(
          (part) => part.kind === 'local-call',
        );
        const content: vscode.LanguageModelToolResultPart[] = [];
        for (const result of message.results) {
          const call = calls[result.callOrdinal];
          if (!call || call.providerCallId === null) {
            return yield* new ModelError({
              kind: 'unsupported',
              message: 'Editor tool results require the original call ID.',
            });
          }
          const text: string[] = [];
          for (const part of result.content) {
            if (part.kind !== 'text') {
              return yield* new ModelError({
                kind: 'unsupported',
                message:
                  'This editor model operation supports text tool results only.',
              });
            }
            text.push(part.text);
          }
          content.push(
            new vscode.LanguageModelToolResultPart(call.providerCallId, [
              new vscode.LanguageModelTextPart(
                result.status === 'error'
                  ? `Error: ${text.join('')}`
                  : text.join(''),
              ),
            ]),
          );
        }
        messages.push(vscode.LanguageModelChatMessage.User(content));
      } else {
        const content: Array<
          vscode.LanguageModelTextPart | vscode.LanguageModelDataPart
        > = [];
        for (const part of message.content) {
          if (part.kind === 'text') {
            content.push(new vscode.LanguageModelTextPart(part.text));
          } else if (
            part.kind === 'image' &&
            part.detail === undefined &&
            config.supportsImageInput &&
            part.mimeType.toLowerCase().startsWith('image/')
          ) {
            content.push(
              vscode.LanguageModelDataPart.image(
                Buffer.from(part.base64, 'base64'),
                part.mimeType,
              ),
            );
          } else {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'The selected editor model supports only text and selected image inputs without detail controls.',
            });
          }
        }
        messages.push(vscode.LanguageModelChatMessage.User(content));
      }
    }
    // The stable editor API has no system role. Keep the existing first-user encoding.
    if (turn.system) {
      const firstUser = messages.find(
        (message) => message.role === vscode.LanguageModelChatMessageRole.User,
      );
      if (firstUser) {
        const first = firstUser.content[0];
        if (first instanceof vscode.LanguageModelTextPart) {
          firstUser.content[0] = new vscode.LanguageModelTextPart(
            first.value ? `${turn.system}\n\n${first.value}` : turn.system,
          );
        } else {
          firstUser.content.unshift(
            new vscode.LanguageModelTextPart(turn.system),
          );
        }
      } else {
        messages.unshift(
          vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelTextPart(turn.system),
          ]),
        );
      }
    }
    return messages;
  });
}

/** Acquire one concrete editor model; reserve request-on-send for a direct user action. */
export const acquireVscodeLanguageModel = Effect.fn(
  'acquireVscodeLanguageModel',
)(function* (
  context: vscode.ExtensionContext,
  configuration: VscodeLanguageModelConfiguration,
  consentMode: 'require-granted' | 'request-on-send' = 'require-granted',
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  const parsed = ModelConfigurationSchema.safeParse(configuration);
  if (!parsed.success || parsed.data.protocol !== 'vscode-lm') {
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The editor model configuration is invalid.',
      cause: parsed.success ? undefined : parsed.error,
    });
  }
  const config = parsed.data;
  const origin: EditorOrigin = Object.freeze({
    protocol: config.protocol,
    codecVersion: 1,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
  });
  if (typeof vscode.lm?.selectChatModels !== 'function') {
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'This host does not expose editor language models.',
    });
  }
  // Discovery has no cancellation parameter. Join it before acquisition can exit.
  const candidates = yield* Effect.tryPromise({
    try: () =>
      Promise.resolve(
        vscode.lm.selectChatModels({
          id: config.requestedModel,
          vendor: config.deployment.vendor,
          version: config.deployment.version,
        }),
      ),
    catch: (cause) => nativeFailure(cause, origin),
  }).pipe(Effect.uninterruptible);
  const selected = candidates.find(
    (model) =>
      model.id === config.requestedModel &&
      model.vendor === config.deployment.vendor &&
      model.version === config.deployment.version,
  );
  if (!selected) {
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The exact selected editor model is no longer available.',
    });
  }
  const checkAccess = Effect.gen(function* () {
    const access =
      context.languageModelAccessInformation.canSendRequest(selected);
    if (
      access === false ||
      (access === undefined && consentMode === 'require-granted')
    ) {
      return yield* new ModelError({
        kind: 'authentication',
        message:
          access === false
            ? 'Access to the selected editor model is unavailable.'
            : 'The editor cannot confirm that this model exists and access has been granted. Refresh the model list or request access from the settings view.',
      });
    }
  });
  yield* checkAccess;
  const acquisitionId = randomUUID();
  let retired = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      retired = true;
    }),
  );

  const prepareTurn: Model['prepareTurn'] = (request) =>
    Effect.gen(function* () {
      if (retired) {
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'The editor model acquisition has retired.',
        });
      }
      const input = TurnRequestSchema.safeParse(request);
      if (!input.success) {
        return yield* new ModelError({
          kind: 'invalid-request',
          message: 'The model request is invalid.',
          cause: input.error,
        });
      }
      const authored = input.data;
      if (
        (authored.mode !== undefined && authored.mode !== 'foreground') ||
        (authored.toolChoice !== undefined && authored.toolChoice !== 'auto') ||
        Object.entries(authored).some(
          ([key, value]) =>
            value !== undefined &&
            !['mode', 'system', 'messages', 'tools', 'toolChoice'].includes(
              key,
            ),
        )
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'The editor API does not expose these requested generation controls.',
        });
      }
      const turn: EditorTurn = Object.freeze({
        ...origin,
        mode: 'foreground',
        acquisitionId,
        system: authored.system,
        messages: authored.messages,
        tools: authored.tools ?? Object.freeze([]),
        controls: Object.freeze({
          justification: config.defaults.justification,
          toolChoice: 'auto',
        }),
      });
      yield* lowerMessages(turn, config);
      return turn;
    });

  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const parsedTurn = ResolvedTurnSchema.safeParse(input);
        if (
          !parsedTurn.success ||
          parsedTurn.data.protocol !== 'vscode-lm' ||
          retired ||
          parsedTurn.data.acquisitionId !== acquisitionId ||
          !sameModelOrigin(parsedTurn.data, origin)
        ) {
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'The prepared turn belongs to another or retired editor acquisition.',
          });
        }
        const turn = parsedTurn.data;
        const messages = yield* lowerMessages(turn, config);
        const cancellation = new vscode.CancellationTokenSource();
        let request: Promise<vscode.LanguageModelChatResponse> | undefined;
        let iterator: AsyncIterator<unknown> | undefined;
        let pendingNext: Promise<IteratorResult<unknown>> | undefined;
        yield* Effect.addFinalizer((exit) => {
          const join = Effect.gen(function* () {
            if (request !== undefined) {
              const outstanding = request;
              const response = yield* Effect.tryPromise({
                try: () => outstanding,
                catch: (cause) => cause,
              });
              iterator ??= response.stream[Symbol.asyncIterator]();
            }
            if (pendingNext !== undefined) {
              const outstanding = pendingNext;
              yield* Effect.tryPromise({
                try: () => outstanding,
                catch: (cause) => cause,
              });
            }
          }).pipe(
            Effect.catch((cause) => {
              if (
                (cancellation.token.isCancellationRequested &&
                  cause instanceof vscode.CancellationError) ||
                (Exit.isFailure(exit) &&
                  exit.cause.reasons.some(
                    (reason) =>
                      Cause.isFailReason(reason) &&
                      reason.error instanceof ModelError &&
                      reason.error.cause === cause,
                  ))
              ) {
                return Effect.void;
              }
              return Effect.die(nativeFailure(cause, origin));
            }),
          );
          return Effect.sync(() => cancellation.cancel()).pipe(
            Effect.ensuring(join),
            Effect.ensuring(
              Effect.suspend(() => {
                const close = iterator?.return?.bind(iterator);
                return close === undefined
                  ? Effect.void
                  : Effect.tryPromise({
                      try: () => Promise.resolve(close()),
                      catch: (cause) => nativeFailure(cause, origin),
                    }).pipe(Effect.orDie);
              }),
            ),
            Effect.ensuring(Effect.sync(() => cancellation.dispose())),
          );
        });
        yield* checkAccess;
        const response = yield* Effect.tryPromise({
          try: () => {
            request = Promise.resolve(
              selected.sendRequest(
                messages,
                {
                  justification: turn.controls.justification,
                  ...(turn.tools.length === 0
                    ? {}
                    : {
                        tools: turn.tools.map((tool) => ({
                          name: tool.name,
                          description: tool.description,
                          inputSchema: tool.parameters,
                        })),
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                      }),
                },
                cancellation.token,
              ),
            );
            return request;
          },
          catch: (cause) => nativeFailure(cause, origin),
        });
        iterator = response.stream[Symbol.asyncIterator]();
        const body = iterator;
        request = undefined;
        const content: Array<TurnResult['content'][number]> = [];
        let textParts: string[] = [];
        const flushText = () => {
          if (textParts.length === 0) return;
          content.push({
            kind: 'message',
            content: [{ kind: 'text', text: textParts.join('') }],
          });
          textParts = [];
        };
        let phaseOpen = false;
        let completed = false;
        const callIds = new Set<string>();
        return Stream.fromPull(
          Effect.succeed(
            Effect.gen(function* () {
              while (true) {
                if (completed) return yield* Cause.done();
                const next = yield* Effect.tryPromise({
                  try: () => {
                    pendingNext = Promise.resolve(body.next());
                    return pendingNext;
                  },
                  catch: (cause) => nativeFailure(cause, origin),
                });
                pendingNext = undefined;
                if (cancellation.token.isCancellationRequested)
                  return yield* Effect.interrupt;
                const events: TurnEvent[] = [];
                if (next.done) {
                  flushText();
                  const result = TurnResultSchema.safeParse({
                    requestedOrigin: origin,
                    providerResponseId: null,
                    returnedModel: null,
                    modelFingerprint: null,
                    content,
                    finishReason: null,
                    usage: null,
                  });
                  if (!result.success)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The editor returned an invalid completed response.',
                      cause: result.error,
                    });
                  if (phaseOpen)
                    events.push({
                      kind: 'phase',
                      part: 'text',
                      boundary: 'end',
                      providerItemIndex: null,
                    });
                  events.push({ kind: 'completed', result: result.data });
                  completed = true;
                } else if (next.value instanceof vscode.LanguageModelTextPart) {
                  const text = next.value.value;
                  if (typeof text !== 'string')
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'The editor returned an invalid text part.',
                    });
                  textParts.push(text);
                  if (text.length > 0) {
                    if (!phaseOpen)
                      events.push({
                        kind: 'phase',
                        part: 'text',
                        boundary: 'start',
                        providerItemIndex: null,
                      });
                    phaseOpen = true;
                    events.push({
                      kind: 'delta',
                      part: 'text',
                      text,
                      providerItemIndex: null,
                    });
                  }
                } else if (
                  next.value instanceof vscode.LanguageModelToolCallPart
                ) {
                  const call = next.value;
                  const args = JsonObjectSchema.safeParse(call.input);
                  if (
                    !config.supportsToolCalling ||
                    turn.tools.length === 0 ||
                    typeof call.callId !== 'string' ||
                    call.callId.length === 0 ||
                    callIds.has(call.callId) ||
                    typeof call.name !== 'string' ||
                    call.name.length === 0 ||
                    !args.success
                  ) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The editor returned an incomplete or duplicate tool call.',
                    });
                  }
                  callIds.add(call.callId);
                  flushText();
                  content.push({
                    kind: 'local-call',
                    providerCallId: call.callId,
                    name: call.name,
                    // The editor hands over `input` already parsed and never
                    // exposes the model's raw argument bytes, so there are no
                    // provider bytes to retain here. This serialization is not
                    // a re-encode of a parse whose original was dropped: the
                    // object is the only representation this source ever had.
                    argumentsText: JSON.stringify(args.data),
                    arguments: args.data,
                  });
                  if (phaseOpen)
                    events.push({
                      kind: 'phase',
                      part: 'text',
                      boundary: 'end',
                      providerItemIndex: null,
                    });
                  phaseOpen = false;
                } else {
                  return yield* new ModelError({
                    kind: 'unsupported',
                    message:
                      'The editor returned an unsupported response part.',
                  });
                }
                if (events.length > 0)
                  return events as [TurnEvent, ...TurnEvent[]];
              }
            }),
          ),
        );
      }),
    );
  const generateTurn: Model['generateTurn'] = (turn) =>
    streamTurn(turn).pipe(
      Stream.runFold(
        () => undefined as TurnResult | undefined,
        (result, event) => (event.kind === 'completed' ? event.result : result),
      ),
      Effect.flatMap((result) =>
        result === undefined
          ? new ModelError({
              kind: 'malformed-output',
              message: 'The editor stream ended without a completed response.',
            })
          : Effect.succeed(result),
      ),
    );
  return Object.freeze({ prepareTurn, streamTurn, generateTurn });
});
