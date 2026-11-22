/**
 * The coding plans' usage meters, as the settings page and the terminal's
 * status bar show them: what the process knows of each plan's quota
 * (`PlanQuotas`, which asks the plan's endpoint and keeps the answer),
 * named for the person. A read always succeeds with a snapshot: a failed
 * request is the snapshot's `unavailable` state, so a caller has no error
 * case to write.
 */
import { Effect, Record as EffectRecord } from 'effect';
import { PlanQuotas, type PlanQuota } from '@texra-ai/worldline/host';
import type { Secrets, SettingsStores } from '@texra-ai/worldline/plugins';
import type { HttpClient } from 'effect/http';

import { providerDisplayName } from '@texra-ai/llm';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
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

/** `quota` as the meter of `plan`. A coding plan's quota comes from its
 *  endpoint, never from a reply or from nowhere. */
const snapshotOf = (
  plan: CodingPlanSubscription,
  quota: PlanQuota,
): Effect.Effect<SubscriptionUsageSnapshot> => {
  const providerName = providerDisplayName(plan.apiProvider);
  switch (quota.state) {
    case 'read':
      return Effect.succeed({
        state: 'available',
        providerName,
        planName: quota.planName ?? plan.displayName,
        windows: [...quota.windows],
        fetchedAt: quota.at,
      });
    case 'failed':
      return Effect.succeed({
        state: 'unavailable',
        providerName,
        planName: plan.displayName,
        windows: [],
        fetchedAt: quota.at,
        reason: quota.reason,
      });
    default:
      return Effect.die(
        new Error(
          `${plan.displayName}'s quota is ${quota.state}; a coding plan's is read from its endpoint.`,
        ),
      );
  }
};

/** The usage of `provider`'s plan, with the key and settings `stores` hold. */
export const subscriptionUsage = (
  stores: SettingsStores,
  provider: SubscriptionUsageProvider,
): Effect.Effect<
  SubscriptionUsageSnapshot,
  never,
  PlanQuotas | HttpClient.HttpClient | Secrets
> => {
  const plan = PLAN_BY_PROVIDER[provider];
  return PlanQuotas.use((quotas) => quotas.read(plan.usageRoute, stores)).pipe(
    Effect.flatMap((quota) => snapshotOf(plan, quota)),
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
