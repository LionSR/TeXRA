// Third-party imports
import { Schema, Struct } from 'effect';

/**
 * Scheme, host and path only. The origin is written into durable rows that
 * are never scrubbed, and a URL check alone admits `user:key@host`,
 * `?api-key=` and `#api-key=` alike.
 */
const EndpointSchema = Schema.String.check(
  Schema.makeFilter(
    (endpoint) => {
      if (!URL.canParse(endpoint)) return 'Expected a URL';
      const url = new URL(endpoint);
      return (
        url.username === '' && url.password === '' && !/[?#]/.test(endpoint)
      );
    },
    { message: 'Endpoints carry no userinfo, query string or fragment.' },
  ),
);
/** Whether a binding serves turns as remote background work (`Model.background`). */
export const BackgroundCapabilitySchema = Schema.Literals([
  'supported',
  'unsupported',
]);
/** The model a binding requests and the deployment it is served from: the
 *  endpoint and the scope of the credential that pays for it. */
export const BindingSchema = Schema.Struct({
  requestedModel: Schema.NonEmptyString,
  deployment: Schema.Struct({
    endpoint: EndpointSchema,
    credentialScope: Schema.NonEmptyString,
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
]);

/** Selected binding, distinct from an optional returned model version. */
export const ModelOriginSchema = BindingSchema.mapFields(
  Struct.assign({
    protocol: TurnProtocolSchema,
    codecVersion: Schema.Literal(1),
  }),
);
/** The binding a turn was requested on: model, deployment and protocol. */
export type ModelOrigin = typeof ModelOriginSchema.Type;

/** The origin a wire model stamps on its turns: the one place `codecVersion` is written. */
export const originOf = <P extends ModelOrigin['protocol']>(
  config: Pick<ModelOrigin, 'requestedModel' | 'deployment'> & {
    readonly protocol: P;
  },
): ModelOrigin & { readonly protocol: P } =>
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
  return (
    left.deployment.endpoint === right.deployment.endpoint &&
    left.deployment.credentialScope === right.deployment.credentialScope
  );
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

/** Materialized JSON: a string-keyed object of JSON values. */
export const JsonObjectSchema = Schema.Unknown.check(
  Schema.makeFilter((value) => hasSupportedJsonKeys(value), {
    message:
      'JSON cannot contain cycles or __proto__ keys, which this codec cannot preserve.',
  }),
).pipe(Schema.decodeTo(Schema.JsonObject));

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
 *  next message, in call order. Only the next request needs them settled.
 *  Returns the schema issues found, one per offending message. */
export function checkPreparedHistory(
  messages: readonly PreparedHistoryEntry[],
): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = [];
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
        issues.push({
          path: [index],
          issue:
            'Every local call requires one adjacent, complete, ordinal-ordered tool-result group before another generation.',
        });
      }
    } else if (message.role === 'tool') {
      const previous = messages[index - 1];
      if (
        previous?.role !== 'assistant' ||
        !previous.content.some((part) => part.kind === 'local-call')
      ) {
        issues.push({
          path: [index],
          issue:
            'Tool results require an immediately preceding calling assistant.',
        });
      }
    }
  }
  return issues;
}
