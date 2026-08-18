import { codingPlanSubscriptionRuntimes } from '@model/codingPlanSubscriptions';
import {
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
import {
  isPreferXaiSubscription,
  setPreferXaiSubscription,
} from '@model/xai/xaiPreference';
import {
  QUOTA_FALLBACK_ROUTES,
  type QuotaFallbackRoute,
  type QuotaFallbackRouteId,
} from '@shared/quotaFallbackRoutes';

export interface QuotaFallbackRuntime {
  readonly descriptor: QuotaFallbackRoute;
  readonly getEnabled: () => boolean;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly restoreEnabled: (enabled: boolean) => Promise<void>;
}

const OAUTH_RUNTIME_BY_ID = {
  chatgpt: {
    getEnabled: isPreferCodexSubscription,
    setEnabled: async (enabled) => {
      await setPreferCodexSubscription(enabled);
    },
    restoreEnabled: async (enabled) => {
      await setPreferCodexSubscription(enabled);
    },
  },
  grok: {
    getEnabled: isPreferXaiSubscription,
    setEnabled: async (enabled) => {
      await setPreferXaiSubscription(enabled);
    },
    restoreEnabled: async (enabled) => {
      await setPreferXaiSubscription(enabled);
    },
  },
} as const satisfies Record<
  Extract<QuotaFallbackRouteId, 'chatgpt' | 'grok'>,
  Omit<QuotaFallbackRuntime, 'descriptor'>
>;

function runtimeFor(
  descriptor: QuotaFallbackRoute,
): Omit<QuotaFallbackRuntime, 'descriptor'> {
  if (descriptor.codingPlanId !== undefined) {
    const coding = codingPlanSubscriptionRuntimes.find(
      (candidate) => candidate.descriptor.id === descriptor.codingPlanId,
    );
    if (coding === undefined) {
      throw new Error(`Unknown coding-plan subscription: ${descriptor.id}`);
    }
    return {
      getEnabled: coding.getEnabled,
      setEnabled: coding.setEnabled,
      restoreEnabled: coding.restoreEnabled,
    };
  }
  return OAUTH_RUNTIME_BY_ID[descriptor.id as 'chatgpt' | 'grok'];
}

/** Runtime catalog consumed by retry policy. */
export const quotaFallbackRuntimes = Object.freeze(
  QUOTA_FALLBACK_ROUTES.map((descriptor) =>
    Object.freeze({
      descriptor,
      ...runtimeFor(descriptor),
    }),
  ),
);
