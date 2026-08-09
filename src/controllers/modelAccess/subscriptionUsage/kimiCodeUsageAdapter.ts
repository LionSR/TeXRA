import {
  asObject,
  assertSubscriptionUsageResponse,
  numberField,
  ratioWindow,
  stringField,
  timestampField,
} from './subscriptionUsageParsing';
import type { SubscriptionUsageHttp } from './codexUsageAdapter';
import type {
  ParsedSubscriptionUsage,
  SubscriptionUsageWindow,
} from './subscriptionUsageTypes';

export const KIMI_CODE_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';

function kimiWindow(
  name: string,
  value: unknown,
): SubscriptionUsageWindow | undefined {
  const item = asObject(value);
  const detail = asObject(item?.detail) ?? item;
  const limit = numberField(detail, 'limit', 'max_value_usd', 'maxValueUsd');
  const remaining = numberField(detail, 'remaining');
  let used = numberField(detail, 'used', 'used_value_usd', 'usedValueUsd');
  if (used === undefined && limit !== undefined && remaining !== undefined) {
    used = Math.max(0, limit - remaining);
  }
  return ratioWindow(
    name,
    used,
    limit,
    timestampField(detail, 'resetTime', 'resets_at', 'reset_at'),
  );
}

function addWindow(
  windows: Map<string, SubscriptionUsageWindow>,
  name: string,
  value: unknown,
): void {
  const window = kimiWindow(name, value);
  if (window) windows.set(name, window);
}

export function parseKimiCodeUsage(body: unknown): ParsedSubscriptionUsage {
  const root = asObject(body);
  const data = asObject(root?.data) ?? root;
  const windows = new Map<string, SubscriptionUsageWindow>();
  const limits = data?.limits;

  if (Array.isArray(limits)) {
    for (const [index, item] of limits.entries()) {
      const object = asObject(item);
      const rawName = stringField(object, 'name', 'type', 'quota_type');
      const name =
        rawName ?? (index === 0 ? 'five_hour' : `limit_${index + 1}`);
      addWindow(windows, name, item);
    }
  } else {
    const limitsObject = asObject(limits);
    if (limitsObject) {
      for (const [name, value] of Object.entries(limitsObject)) {
        addWindow(windows, name, value);
      }
    }
  }

  addWindow(windows, 'weekly_limit', data?.usage);

  // Older responses named the two quota records directly and reported USD
  // usage rather than limit/remaining counts.
  addWindow(windows, 'five_hour', data?.quota_5_hour);
  addWindow(windows, 'seven_day', data?.quota_7_day);

  return {
    planName:
      stringField(data, 'plan', 'plan_name', 'account_status') ?? 'Kimi Code',
    windows: [...windows.values()],
  };
}

export async function fetchKimiCodeUsage(
  http: SubscriptionUsageHttp,
  apiKey: string,
  signal: AbortSignal,
): Promise<ParsedSubscriptionUsage> {
  const response = await http(KIMI_CODE_USAGE_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
  });
  assertSubscriptionUsageResponse(response);
  return parseKimiCodeUsage(await response.json());
}
