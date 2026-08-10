import type { SubscriptionUsageWindow } from '@shared/schemas';

import {
  asObject,
  assertSubscriptionUsageResponse,
  numberField,
  stringField,
  timestampField,
  usageWindow,
  type JsonObject,
  type ParsedSubscriptionUsage,
  type SubscriptionUsageHttp,
} from './subscriptionUsageParsing';

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export interface ChatGptUsageCredential {
  readonly accessToken: string;
  readonly accountId?: string;
}

function validWindowSeconds(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function usageWindowName(
  fallbackName: 'primary' | 'secondary',
  windowSeconds: number | undefined,
): string {
  if (windowSeconds === 18_000) return 'five_hour';
  if (windowSeconds === 604_800) return 'seven_day';
  if (windowSeconds === 2_592_000) return 'thirty_day';
  if (windowSeconds !== undefined && windowSeconds % 86_400 === 0) {
    return `${windowSeconds / 86_400}_day`;
  }
  if (windowSeconds !== undefined && windowSeconds % 3_600 === 0) {
    return `${windowSeconds / 3_600}_hour`;
  }
  return fallbackName;
}

function parseWindows(
  rateLimits: JsonObject | undefined,
  keys: readonly [string, string],
  fetchedAt: number,
): SubscriptionUsageWindow[] {
  const windows: SubscriptionUsageWindow[] = [];
  for (const [fallbackName, key] of [
    ['primary', keys[0]],
    ['secondary', keys[1]],
  ] as const) {
    const raw = asObject(rateLimits?.[key]);
    if (!raw) continue;
    let limitWindowSeconds = validWindowSeconds(
      numberField(raw, 'limit_window_seconds', 'limitWindowSeconds'),
    );
    const windowMinutes = numberField(raw, 'window_minutes', 'windowMinutes');
    if (limitWindowSeconds === undefined && windowMinutes !== undefined) {
      limitWindowSeconds = validWindowSeconds(windowMinutes * 60);
    }
    let resetAt = timestampField(
      raw,
      'reset_at',
      'resets_at',
      'expiry_date',
      'expires_at',
      'resetTime',
    );
    const resetAfterSeconds = numberField(
      raw,
      'reset_after_seconds',
      'resets_in_seconds',
    );
    if (resetAt === undefined && resetAfterSeconds !== undefined) {
      resetAt = fetchedAt + resetAfterSeconds * 1000;
    }
    const window = usageWindow(
      usageWindowName(fallbackName, limitWindowSeconds),
      {
        used: numberField(raw, 'used_percent', 'usedPercent'),
        remaining: numberField(raw, 'remaining_percent', 'remainingPercent'),
      },
      {
        resetAt,
        ...(limitWindowSeconds !== undefined ? { limitWindowSeconds } : {}),
      },
    );
    if (window) windows.push(window);
  }
  return windows;
}

export function parseChatGptUsage(
  body: unknown,
  fetchedAt = Date.now(),
): ParsedSubscriptionUsage {
  const root = asObject(body);
  const normalizedRateLimits = asObject(root?.rate_limits);
  const wireRateLimit = asObject(root?.rate_limit) ?? root;
  let windows = parseWindows(
    wireRateLimit,
    ['primary_window', 'secondary_window'],
    fetchedAt,
  );
  if (windows.length === 0) {
    windows = parseWindows(
      normalizedRateLimits,
      ['primary', 'secondary'],
      fetchedAt,
    );
  }

  return {
    planName:
      stringField(root, 'plan_type', 'planType') ??
      stringField(normalizedRateLimits, 'plan_type', 'planType') ??
      'ChatGPT Coding Plan',
    windows,
  };
}

export async function fetchChatGptUsage(
  http: SubscriptionUsageHttp,
  credential: ChatGptUsageCredential,
  signal: AbortSignal,
): Promise<ParsedSubscriptionUsage> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    'User-Agent': 'codex-cli',
  };
  if (credential.accountId) {
    headers['ChatGPT-Account-Id'] = credential.accountId;
  }
  const response = await http(CHATGPT_USAGE_URL, {
    method: 'GET',
    headers,
    signal,
  });
  assertSubscriptionUsageResponse(response);
  return parseChatGptUsage(await response.json());
}
