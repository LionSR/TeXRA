/**
 * Why a model can or cannot run: the kind a host's model options carry, and
 * the one table every host reads it through.
 */
import { Schema } from 'effect';

/** Why a model option can or cannot run, as it travels on the wire. */
export const ModelAvailabilityKindSchema = Schema.Literals([
  'provider-key',
  'missing-key',
  // The provider's key is stored, or may be, but the secret store could not
  // be read: not a missing key, so never worded as one.
  'key-unreadable',
  'retired',
  // Only OpenRouter or GitHub Copilot serves the model, and TeXRA calls
  // neither.
  'unserved',
  // ChatGPT-subscription (Codex) access via the user's own OAuth session.
  'subscription-access',
  // The same, on the user's Grok (xAI) subscription.
  'xai-subscription-access',
  // The model id survives in a host's enabled-models list but the live
  // registry no longer describes it, so nothing can route a request for it.
  'unknown-model',
]);
/** Why a model option can or cannot run. */
export type ModelAvailabilityKind = typeof ModelAvailabilityKindSchema.Type;

/**
 * What a kind means: whether a run can use the model, and whether the block is
 * a missing key (a surface's words for each kind are the app's). Declared once
 * here, next to the kind, so the answer is carried on the wire as the kind
 * alone and every host reads the same table instead of pre-fanned fields.
 *
 * Written with `as const satisfies` so each `available` literal survives for
 * `computeModelOptions`'s derivation of the unavailable kinds, while a missing
 * or misshapen kind is still a compile error, and frozen to the depth it is
 * read at: the table crosses into every host that decides whether a model can
 * run, and `readonly` is compile-time only.
 */
export const MODEL_AVAILABILITY_STATUS = {
  'provider-key': { available: true, requiresKey: false },
  'missing-key': { available: false, requiresKey: true },
  'key-unreadable': { available: false, requiresKey: false },
  'subscription-access': { available: true, requiresKey: false },
  'xai-subscription-access': { available: true, requiresKey: false },
  retired: { available: false, requiresKey: false },
  unserved: { available: false, requiresKey: false },
  'unknown-model': { available: false, requiresKey: false },
} as const satisfies Record<
  ModelAvailabilityKind,
  { readonly available: boolean; readonly requiresKey: boolean }
>;
for (const status of Object.values(MODEL_AVAILABILITY_STATUS))
  Object.freeze(status);
Object.freeze(MODEL_AVAILABILITY_STATUS);

/**
 * Whether an option row can be run as shipped: `readModelOptions`
 * already resolved the access question, so a caller only has to read its
 * verdict. Lives with the kind so delegation's model list and the CLI's
 * picker can never drift apart on what "available" means.
 */
export function isModelOptionAvailable(model: {
  readonly availability?: ModelAvailabilityKind;
}): boolean {
  return (
    model.availability === undefined ||
    MODEL_AVAILABILITY_STATUS[model.availability].available
  );
}
