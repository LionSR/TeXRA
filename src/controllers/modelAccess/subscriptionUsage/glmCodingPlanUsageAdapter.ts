import {
  asObject,
  assertSubscriptionUsageResponse,
  numberField,
  stringField,
  timestampField,
  usageWindow,
} from './subscriptionUsageParsing';
import type { SubscriptionUsageHttp } from './codexUsageAdapter';
import type {
  ParsedSubscriptionUsage,
  SubscriptionUsageWindow,
} from './subscriptionUsageTypes';

export const GLM_CODING_PLAN_USAGE_URL =
  'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
export const GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL =
  'https://api.z.ai/api/monitor/usage/quota/limit';

interface GlmLimitEntry {
  readonly value: Record<string, unknown>;
  readonly resetAt?: number;
}

function classifyGlmLimits(values: readonly unknown[]): {
  readonly fiveHour?: GlmLimitEntry;
  readonly weekly?: GlmLimitEntry;
} {
  let fiveHour: GlmLimitEntry | undefined;
  let weekly: GlmLimitEntry | undefined;
  const unclassified: GlmLimitEntry[] = [];

  for (const value of values) {
    const item = asObject(value);
    if (!item) continue;
    const type = stringField(item, 'type')?.toUpperCase();
    if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') continue;
    const entry = {
      value: item,
      resetAt: timestampField(item, 'nextResetTime', 'resetTime', 'resets_at'),
    };
    const unit = numberField(item, 'unit');
    if (unit === 3 && !fiveHour) fiveHour = entry;
    else if (unit === 6 && !weekly) weekly = entry;
    else unclassified.push(entry);
  }

  unclassified.sort((left, right) => {
    if (left.resetAt === undefined) return -1;
    if (right.resetAt === undefined) return 1;
    return left.resetAt - right.resetAt;
  });
  for (const entry of unclassified) {
    if (!fiveHour) fiveHour = entry;
    else if (!weekly) weekly = entry;
  }
  return { fiveHour, weekly };
}

function addRemainingWindows(
  windows: Map<string, SubscriptionUsageWindow>,
  value: unknown,
  prefix = '',
): void {
  const object = asObject(value);
  if (!object) return;
  const interval = usageWindow(
    `${prefix}five_hour`,
    {
      remaining: numberField(
        object,
        'current_interval_remaining_percent',
        'currentIntervalRemainingPercent',
      ),
    },
    {
      resetAt: timestampField(
        object,
        'current_interval_end_time',
        'currentIntervalEndTime',
        'interval_end_time',
      ),
    },
  );
  if (interval) windows.set(interval.name, interval);

  const weekly = usageWindow(
    `${prefix}weekly`,
    {
      remaining: numberField(
        object,
        'current_weekly_remaining_percent',
        'currentWeeklyRemainingPercent',
      ),
    },
    {
      resetAt: timestampField(
        object,
        'weekly_end_time',
        'weeklyEndTime',
        'current_weekly_end_time',
      ),
    },
  );
  if (weekly) windows.set(weekly.name, weekly);

  const modelRemains = object.model_remains ?? object.modelRemains;
  if (Array.isArray(modelRemains)) {
    for (const modelRemain of modelRemains) {
      const model = asObject(modelRemain);
      const modelName = stringField(model, 'model_name', 'modelName');
      addRemainingWindows(
        windows,
        modelRemain,
        modelName ? `${modelName}:` : 'model:',
      );
    }
  } else {
    const modelRemainsObject = asObject(modelRemains);
    if (modelRemainsObject) {
      for (const [modelName, remains] of Object.entries(modelRemainsObject)) {
        addRemainingWindows(windows, remains, `${modelName}:`);
      }
    }
  }
}

export function parseGlmCodingPlanUsage(
  body: unknown,
): ParsedSubscriptionUsage {
  const root = asObject(body);
  if (root?.success === false) return { windows: [] };
  const data = asObject(root?.data) ?? root;
  const windows = new Map<string, SubscriptionUsageWindow>();
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const classified = classifyGlmLimits(limits);

  for (const [name, entry] of [
    ['five_hour', classified.fiveHour],
    ['weekly', classified.weekly],
  ] as const) {
    if (!entry) continue;
    const window = usageWindow(
      name,
      {
        used: numberField(entry.value, 'percentage', 'used_percent'),
        remaining: numberField(entry.value, 'remaining_percent'),
      },
      { resetAt: entry.resetAt },
    );
    if (window) windows.set(name, window);
  }

  addRemainingWindows(windows, data);

  return {
    planName:
      stringField(data, 'level', 'plan', 'plan_name') ?? 'GLM Coding Plan',
    windows: [...windows.values()],
  };
}

export async function fetchGlmCodingPlanUsage(
  http: SubscriptionUsageHttp,
  apiKey: string,
  signal: AbortSignal,
  usageUrl = GLM_CODING_PLAN_USAGE_URL,
): Promise<ParsedSubscriptionUsage> {
  const response = await http(usageUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en',
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    signal,
  });
  assertSubscriptionUsageResponse(response);
  return parseGlmCodingPlanUsage(await response.json());
}
