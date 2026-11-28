/**
 * A plan's usage meter, as the status bar, the settings page and the
 * terminal show it: what the process knows of the plan's quota
 * (`PlanQuotas`), as the one record they read. A read always succeeds: a
 * failed request is the record's `unknown`, so a caller has no error case
 * to write.
 */
import { Effect, Record as EffectRecord } from 'effect';
import { PlanQuotas, type PlanQuota } from '@texra-ai/worldline/host';
import type { Secrets, SettingsStores } from '@texra-ai/worldline/plugins';
import type { DeclinableUsageRoute } from '@texra-ai/worldline/schemas';
import type { HttpClient } from 'effect/http';

import type {
  PlanUsage,
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshots,
} from '@texra/shared/model/subscriptionUsage';
import {
  codingPlanForUsageRoute,
  type CodingPlanSubscription,
} from '@texra/shared/model/codingPlans';

/** Each subscription's catalog plan, by the provider that reports its usage. */
const PLAN_BY_PROVIDER = {
  kimiCode: codingPlanForUsageRoute('kimi-code-subscription'),
  glmCodingPlan: codingPlanForUsageRoute('glm-coding-plan-subscription'),
} satisfies Record<SubscriptionUsageProvider, CodingPlanSubscription>;

/** `quota` as `plan`'s meter; none for a plan nothing states the quota of. */
export const planUsageOf = (
  plan: DeclinableUsageRoute,
  quota: PlanQuota,
): PlanUsage | undefined => {
  switch (quota.state) {
    case 'read':
    case 'observed':
      return {
        plan,
        ...(quota.state === 'read' &&
          quota.planName && { planName: quota.planName }),
        at: quota.at,
        windows: quota.windows.map((window) => ({
          name: window.name,
          percentUsed: window.percentUsed,
          resetAt: window.resetAt,
        })),
      };
    case 'failed':
      return { plan, windows: [], unknown: quota.reason };
    case 'unobserved':
      return { plan, windows: [], unknown: quota.state };
    case 'unread':
      return undefined;
  }
};

/** The usage of `provider`'s plan, with the key and settings `stores` hold.
 *  A coding plan's quota comes from its endpoint, so it always has a meter. */
export const subscriptionUsage = (
  stores: SettingsStores,
  provider: SubscriptionUsageProvider,
): Effect.Effect<
  PlanUsage,
  never,
  PlanQuotas | HttpClient.HttpClient | Secrets
> => {
  const plan = PLAN_BY_PROVIDER[provider];
  return PlanQuotas.use((quotas) => quotas.read(plan.usageRoute, stores)).pipe(
    Effect.flatMap((quota) => {
      const usage = planUsageOf(plan.usageRoute, quota);
      return usage === undefined
        ? Effect.die(
            new Error(
              `${plan.displayName}'s quota is ${quota.state}; a coding plan's is read from its endpoint.`,
            ),
          )
        : Effect.succeed(usage);
    }),
  );
};

/** One snapshot per coding plan, for a settings-view refresh. Each key is
 *  the provider id itself, so key and provider never drift apart. */
export const allSubscriptionUsage = (
  stores: SettingsStores,
): Effect.Effect<
  SubscriptionUsageSnapshots,
  never,
  PlanQuotas | HttpClient.HttpClient | Secrets
> =>
  Effect.all(
    EffectRecord.map(PLAN_BY_PROVIDER, (_plan, provider) =>
      subscriptionUsage(stores, provider),
    ),
    { concurrency: 'unbounded' },
  );

/** Drop `provider`'s cached usage (every plan's when omitted), so the next
 *  read asks its endpoint. */
export const invalidateSubscriptionUsage = (
  provider?: SubscriptionUsageProvider,
): Effect.Effect<void, never, PlanQuotas> =>
  PlanQuotas.use((quotas) =>
    quotas.invalidate(
      provider === undefined
        ? undefined
        : PLAN_BY_PROVIDER[provider].usageRoute,
    ),
  );
