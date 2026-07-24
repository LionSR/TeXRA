import { z } from 'zod';

/** Mutually exclusive API fallback used outside preferred subscription routes. */
export const ApiAccessModeSchema = z.enum(['included', 'personal']);
export type ApiAccessMode = z.infer<typeof ApiAccessModeSchema>;

/** ChatGPT subscription state shared by every settings surface. */
export const ChatGptSubscriptionStatusSchema = z.object({
  signedIn: z.boolean(),
  email: z.string().nullish(),
  accountId: z.string().nullish(),
  preferSubscription: z.boolean(),
  subscriptionToolUseOnly: z.boolean(),
});
export type ChatGptSubscriptionStatus = z.infer<
  typeof ChatGptSubscriptionStatusSchema
>;

/** Kimi Code subscription state shared by model-access presenters. */
export const KimiCodeSubscriptionStatusSchema = z.object({
  keySet: z.boolean(),
  preferred: z.boolean(),
});
export type KimiCodeSubscriptionStatus = z.infer<
  typeof KimiCodeSubscriptionStatusSchema
>;

/** Complete model-access state, independent of any host or presentation. */
export const ModelAccessStatusSchema = z.object({
  apiMode: ApiAccessModeSchema,
  chatGpt: ChatGptSubscriptionStatusSchema,
  kimiCode: KimiCodeSubscriptionStatusSchema,
  personalApiKeySet: z.boolean(),
  texraSignedIn: z.boolean().optional(),
});
export type ModelAccessStatus = z.infer<typeof ModelAccessStatusSchema>;

export const ModelAccessRouteSchema = z.enum([
  'chatgpt',
  'kimi-code',
  'included',
  'personal',
]);
export type ModelAccessRoute = z.infer<typeof ModelAccessRouteSchema>;

export const MODEL_ACCESS_ROUTE_LABELS = {
  chatgpt: 'ChatGPT subscription',
  'kimi-code': 'Kimi Code subscription',
  included: 'Included TeXRA access',
  personal: 'Personal API keys',
} as const satisfies Record<ModelAccessRoute, string>;

export const MODEL_ACCESS_PREFERENCE_LABELS = {
  chatgpt: `${MODEL_ACCESS_ROUTE_LABELS.chatgpt} preference`,
  'kimi-code': `${MODEL_ACCESS_ROUTE_LABELS['kimi-code']} preference`,
} as const;

export const API_ACCESS_MODE_OPTIONS: readonly {
  readonly value: ApiAccessMode;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: 'included',
    label: MODEL_ACCESS_ROUTE_LABELS.included,
    description:
      'TeXRA supplies access automatically. OpenRouter models remain on the configured OpenRouter key. Personal provider keys offer separate quota and avoid relay caps.',
  },
  {
    value: 'personal',
    label: MODEL_ACCESS_ROUTE_LABELS.personal,
    description:
      'Configured OpenAI, Anthropic, and other provider keys use the corresponding provider account directly, including models outside Included TeXRA access.',
  },
] as const;

export function describeApiAccessModeStatus(
  mode: ApiAccessMode,
  status: Pick<ModelAccessStatus, 'personalApiKeySet' | 'texraSignedIn'>,
): string {
  if (mode === 'included') {
    return status.texraSignedIn === false
      ? 'TeXRA account sign-in required'
      : 'TeXRA account';
  }
  return status.personalApiKeySet
    ? 'Provider API key configured'
    : 'No provider API keys configured';
}
