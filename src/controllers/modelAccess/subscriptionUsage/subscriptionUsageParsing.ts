import { z } from 'zod';

import type { SubscriptionUsageWindow } from '@shared/schemas';
import { clamp, isObject } from '@utils/core';

export type JsonObject = Record<string, unknown>;

export interface ParsedSubscriptionUsage {
  readonly planName?: string;
  readonly windows: readonly SubscriptionUsageWindow[];
}

export interface SubscriptionUsageHttp {
  (url: string, init: RequestInit): Promise<Response>;
}

export class SubscriptionUsageHttpError extends Error {
  constructor(readonly status: number) {
    super(`Subscription usage request failed with HTTP ${status}`);
    this.name = 'SubscriptionUsageHttpError';
  }
}

function assertSubscriptionUsageResponse(response: Response): void {
  if (!response.ok) throw new SubscriptionUsageHttpError(response.status);
}

/**
 * The one subscription-usage request every provider adapter makes. Only the
 * URL and headers differ per provider, so the GET, the abort wiring, and the
 * non-OK status assertion live here; the decoded body goes back to the
 * adapter's own `parseX`.
 */
export async function fetchSubscriptionUsage(
  http: SubscriptionUsageHttp,
  request: {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
  },
): Promise<unknown> {
  const response = await http(request.url, {
    method: 'GET',
    headers: request.headers,
    signal: request.signal,
  });
  assertSubscriptionUsageResponse(response);
  return response.json();
}

export function asObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

/** A loosely-typed wire number: a real number, or a non-blank numeric string
 *  (provider responses mix both for the same logical field). */
const looseFiniteNumber = z.preprocess((value) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return value;
}, z.number().finite());

/** A wire timestamp expressed as an epoch number (seconds or milliseconds,
 *  whichever `looseFiniteNumber` resolves to) or an ISO 8601 (or otherwise
 *  `Date.parse`-able) string, normalized to epoch ms. A value that parses as
 *  a number commits to the numeric interpretation — a negative epoch is
 *  rejected outright rather than falling through to `Date.parse`, which
 *  accepts some non-ISO numeric-looking strings as dates (`Date.parse('-1')`
 *  resolves to 2001-01-01). */
const timestampMsField = z.any().transform((value, ctx) => {
  const numeric = looseFiniteNumber.safeParse(value);
  if (numeric.success) {
    if (numeric.data < 0) {
      ctx.addIssue({ code: 'custom', message: 'negative epoch timestamp' });
      return z.NEVER;
    }
    return Math.trunc(
      numeric.data < 100_000_000_000 ? numeric.data * 1000 : numeric.data,
    );
  }
  if (typeof value !== 'string') {
    ctx.addIssue({ code: 'custom', message: 'not a timestamp' });
    return z.NEVER;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    ctx.addIssue({ code: 'custom', message: 'not a parseable date string' });
    return z.NEVER;
  }
  return parsed;
});

/** Pick the first field, by alias, that parses against `schema`. Every
 *  subscription-usage adapter reads the same provider concept under several
 *  different wire spellings (`reset_at` / `resets_at` / `resetTime` / …), so
 *  the alias fallback lives once here instead of once per detector. */
function pickField<Value>(
  schema: z.ZodType<Value>,
  object: JsonObject | undefined,
  keys: readonly string[],
): Value | undefined {
  for (const key of keys) {
    const result = schema.safeParse(object?.[key]);
    if (result.success) return result.data;
  }
  return undefined;
}

export function stringField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): string | undefined {
  return pickField(z.string().trim().min(1), object, keys);
}

export function numberField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): number | undefined {
  return pickField(looseFiniteNumber, object, keys);
}

export function timestampField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): number | undefined {
  return pickField(timestampMsField, object, keys);
}

export function usageWindow(
  name: string,
  usage: { readonly used?: number; readonly remaining?: number },
  options: {
    readonly resetAt?: number;
    readonly limitWindowSeconds?: number;
  } = {},
): SubscriptionUsageWindow | undefined {
  let percentUsed: number | undefined;
  if (usage.used !== undefined) {
    percentUsed = clamp(usage.used, 0, 100);
  } else if (usage.remaining !== undefined) {
    percentUsed = 100 - clamp(usage.remaining, 0, 100);
  }
  if (percentUsed === undefined) return undefined;
  return {
    name,
    percentUsed,
    percentRemaining: 100 - percentUsed,
    ...(options.resetAt !== undefined ? { resetAt: options.resetAt } : {}),
    ...(options.limitWindowSeconds !== undefined
      ? { limitWindowSeconds: options.limitWindowSeconds }
      : {}),
  };
}

export function ratioWindow(
  name: string,
  used: number | undefined,
  maximum: number | undefined,
  resetAt?: number,
): SubscriptionUsageWindow | undefined {
  if (used === undefined || maximum === undefined || maximum <= 0) {
    return undefined;
  }
  return usageWindow(name, { used: (used / maximum) * 100 }, { resetAt });
}
