// Third-party imports
import { z } from 'zod';

/**
 * Scheme, host and path only. The origin is written into durable rows that
 * are never scrubbed, and `z.url()` alone admits `user:key@host`,
 * `?api-key=` and `#api-key=` alike.
 */
const EndpointSchema = z.url().refine(
  (endpoint) => {
    const url = new URL(endpoint);
    return url.username === '' && url.password === '' && !/[?#]/.test(endpoint);
  },
  { message: 'Endpoints carry no userinfo, query string or fragment.' },
);
export const BackgroundCapabilitySchema = z.enum(['supported', 'unsupported']);
export const BindingSchema = z.strictObject({
  requestedModel: z.string().min(1),
  deployment: z
    .strictObject({
      endpoint: EndpointSchema,
      credentialScope: z.string().min(1),
    })
    .readonly(),
});
/**
 * Every wire surface the package speaks. Usage is billed per surface, so a
 * usage record's provider is the protocol of the turn that produced it.
 */
export const TurnProtocolSchema = z.enum([
  'openai-chat',
  'google-interactions',
  'openai-responses',
  'anthropic-messages',
  'deepseek-chat',
  'kimi-chat',
  'glm-chat',
  'xai-chat',
  'dashscope-chat',
  'minimax-chat',
  'openrouter-chat',
  'vscode-lm',
]);

export const OriginSchema = BindingSchema.extend({
  protocol: TurnProtocolSchema.exclude(['vscode-lm']),
  codecVersion: z.literal(1),
});
export const EditorBindingSchema = BindingSchema.pick({
  requestedModel: true,
}).extend({
  deployment: z
    .strictObject({ vendor: z.string(), version: z.string() })
    .readonly(),
});
export const EditorOriginSchema = EditorBindingSchema.extend({
  protocol: TurnProtocolSchema.extract(['vscode-lm']),
  codecVersion: OriginSchema.shape.codecVersion,
});

/** Selected binding, distinct from an optional returned model version. */
export const ModelOriginSchema = z.discriminatedUnion('protocol', [
  OriginSchema.readonly(),
  EditorOriginSchema.readonly(),
]);
export type ModelOrigin = z.infer<typeof ModelOriginSchema>;

/** Compares the complete non-secret binding, not runtime lineage. */
export function sameModelOrigin(
  left: ModelOrigin,
  right: ModelOrigin,
): boolean {
  if (
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

function freezeJson(value: z.infer<ReturnType<typeof z.json>>): typeof value {
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
export const JsonObjectSchema = z
  .unknown()
  .refine(hasSupportedJsonKeys, {
    message:
      'JSON cannot contain cycles or __proto__ keys, which this codec cannot preserve.',
  })
  .pipe(z.record(z.string(), z.json().transform(freezeJson)).readonly());
