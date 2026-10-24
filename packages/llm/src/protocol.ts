// Third-party imports
import { Schema, SchemaGetter, Struct } from 'effect';

/**
 * Scheme, host and path only. The origin is written into durable rows that
 * are never scrubbed, and `z.url()` alone admits `user:key@host`,
 * `?api-key=` and `#api-key=` alike.
 */
const EndpointSchema =
  Schema.String /* TODO(effect-schema): z.url: add the string check; was `z.url()` */.check(
    Schema.makeFilter(
      (endpoint) => {
        const url = new URL(endpoint);
        return (
          url.username === '' && url.password === '' && !/[?#]/.test(endpoint)
        );
      },
      { message: 'Endpoints carry no userinfo, query string or fragment.' },
    ),
  );
export const BackgroundCapabilitySchema = Schema.Literals([
  'supported',
  'unsupported',
]);
export const BindingSchema = Schema.Struct({
  requestedModel: Schema.String.check(Schema.isMinLength(1)),
  deployment: Schema.Struct({
    endpoint: EndpointSchema,
    credentialScope: Schema.String.check(Schema.isMinLength(1)),
  }),
});
/**
 * Every wire surface the package speaks. Usage is billed per surface, so a
 * usage record's provider is the protocol of the turn that produced it.
 */
export const TurnProtocolSchema = Schema.Literals([
  'google-interactions',
  'openai-responses',
  'anthropic-messages',
  'openrouter-chat',
  'vscode-lm',
]);

export const OriginSchema = BindingSchema.mapFields(
  Struct.assign({
    protocol: TurnProtocolSchema.exclude(['vscode-lm']),
    codecVersion: Schema.Literal(1),
  }),
);
export const EditorBindingSchema = BindingSchema.mapFields(
  Struct.pick(['requestedModel']),
).mapFields(
  Struct.assign({
    deployment: Schema.Struct({
      vendor: Schema.String,
      version: Schema.String,
    }),
  }),
);
export const EditorOriginSchema = EditorBindingSchema.mapFields(
  Struct.assign({
    protocol: TurnProtocolSchema.extract(['vscode-lm']),
    codecVersion: OriginSchema.fields.codecVersion,
  }),
);

/** Selected binding, distinct from an optional returned model version. */
export const ModelOriginSchema = Schema.Union([
  OriginSchema,

  EditorOriginSchema,
]);
/** The binding a turn was requested on: model, deployment and protocol. */
export type ModelOrigin = typeof ModelOriginSchema.Type;

/** The origin a wire model stamps on its turns: the one place `codecVersion` is written. */
export const originOf = <P extends (typeof OriginSchema.Type)['protocol']>(
  config: Pick<typeof OriginSchema.Type, 'requestedModel' | 'deployment'> & {
    readonly protocol: P;
  },
) =>
  Object.freeze({
    protocol: config.protocol,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
    codecVersion: 1 as const,
  });

/** Compares the complete non-secret binding, not runtime lineage. A `null`
 *  left side (content no model produced) matches no binding. */
export function sameModelOrigin(
  left: ModelOrigin | null,
  right: ModelOrigin,
): boolean {
  if (
    left === null ||
    left.protocol !== right.protocol ||
    left.codecVersion !== right.codecVersion ||
    left.requestedModel !== right.requestedModel
  ) {
    return false;
  }
  if (left.protocol === 'vscode-lm' || right.protocol === 'vscode-lm') {
    return (
      left.protocol === 'vscode-lm' &&
      right.protocol === 'vscode-lm' &&
      left.deployment.vendor === right.deployment.vendor &&
      left.deployment.version === right.deployment.version
    );
  }
  return (
    left.deployment.endpoint === right.deployment.endpoint &&
    left.deployment.credentialScope === right.deployment.credentialScope
  );
}

function freezeJson(value: ReturnType<typeof z.json>['Type']): typeof value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeJson(nested);
    Object.freeze(value);
  }
  return value;
}

function hasSupportedJsonKeys(
  value: unknown,
  parents = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (parents.has(value) || Object.hasOwn(value, '__proto__')) return false;
  parents.add(value);
  const valid = Object.values(value).every((nested) =>
    hasSupportedJsonKeys(nested, parents),
  );
  parents.delete(value);
  return valid;
}

/** Materialized JSON, including immutable nested containers. */
export const JsonObjectSchema = Schema.Unknown.check(
  Schema.makeFilter(hasSupportedJsonKeys, {
    message:
      'JSON cannot contain cycles or __proto__ keys, which this codec cannot preserve.',
  }),
).pipe(
  Schema.decodeTo(
    Schema.Record(
      Schema.String,
      Schema.Json.pipe(
        Schema.decodeTo(
          Schema.Unknown /* TODO(effect-schema): transform target schema; was `.transform(freezeJson)` */,
          {
            decode: SchemaGetter.transform(freezeJson),
            encode: SchemaGetter.forbidden(() => 'decode-only'),
          },
        ),
      ),
    ),
  ),
);

/** What the prepared-history rules read of an entry: its role, an
 *  assistant's local calls and a tool group's ordinals. Over any input-part
 *  shape, so a store that holds media by address checks the same rules. */
export type PreparedHistoryEntry =
  | { readonly role: 'user' | 'system' }
  | {
      readonly role: 'assistant';
      readonly content: readonly { readonly kind: string }[];
    }
  | {
      readonly role: 'tool';
      readonly results: readonly { readonly callOrdinal: number }[];
    };
/** The history a turn sends: each assistant's local calls answered by the
 *  next message, in call order. Only the next request needs them settled. */
export function checkPreparedHistory(
  messages: readonly PreparedHistoryEntry[],
  ctx: never /* TODO(effect-schema): RefinementCtx: the filter returns a FilterOutput instead; was `z.RefinementCtx` */,
): void {
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      const calls = message.content.filter(
        (part) => part.kind === 'local-call',
      );
      if (calls.length === 0) continue;
      const results = messages[index + 1];
      if (
        results?.role !== 'tool' ||
        results.results.length !== calls.length ||
        !results.results.every(
          (result, ordinal) => result.callOrdinal === ordinal,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message:
            'Every local call requires one adjacent, complete, ordinal-ordered tool-result group before another generation.',
        });
      }
    } else if (message.role === 'tool') {
      const previous = messages[index - 1];
      if (
        previous?.role !== 'assistant' ||
        !previous.content.some((part) => part.kind === 'local-call')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message:
            'Tool results require an immediately preceding calling assistant.',
        });
      }
    }
  }
}
