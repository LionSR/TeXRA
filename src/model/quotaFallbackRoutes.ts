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
  isCodingPlanQuotaRoute,
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

async function setCodexEnabled(enabled: boolean): Promise<void> {
  await setPreferCodexSubscription(enabled);
}

async function setXaiEnabled(enabled: boolean): Promise<void> {
  await setPreferXaiSubscription(enabled);
}

const OAUTH_RUNTIME_BY_ID = {
  chatgpt: {
    getEnabled: isPreferCodexSubscription,
    setEnabled: setCodexEnabled,
    restoreEnabled: setCodexEnabled,
  },
  grok: {
    getEnabled: isPreferXaiSubscription,
    setEnabled: setXaiEnabled,
    restoreEnabled: setXaiEnabled,
  },
} as const satisfies Record<
  Extract<QuotaFallbackRouteId, 'chatgpt' | 'grok'>,
  Omit<QuotaFallbackRuntime, 'descriptor'>
>;

function runtimeFor(
  descriptor: QuotaFallbackRoute,
): Omit<QuotaFallbackRuntime, 'descriptor'> {
  if (isCodingPlanQuotaRoute(descriptor.id)) {
    const coding = codingPlanSubscriptionRuntimes.find(
      (candidate) => candidate.descriptor.id === descriptor.id,
    );
    if (coding === undefined) {
      throw new Error(`Unknown coding-plan subscription: ${descriptor.id}`);
    }
    // The three methods, not `coding` itself: spreading the whole runtime
    // overwrites the `QuotaFallbackRoute` descriptor with the larger
    // `CodingPlanSubscription` one.
    return {
      getEnabled: coding.getEnabled,
      setEnabled: coding.setEnabled,
      restoreEnabled: coding.restoreEnabled,
    };
  }
  return OAUTH_RUNTIME_BY_ID[descriptor.id];
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
