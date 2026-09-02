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

/** A wire timestamp expressed as epoch seconds or epoch milliseconds
 *  (whichever a `looseFiniteNumber` resolves to), normalized to epoch ms. */
const epochMsField = looseFiniteNumber.pipe(
  z
    .number()
    .nonnegative()
    .transform((value) =>
      Math.trunc(value < 100_000_000_000 ? value * 1000 : value),
    ),
);

/** A wire timestamp expressed as an ISO 8601 (or otherwise `Date.parse`-able)
 *  string, normalized to epoch ms. */
const isoTimestampField = z.string().transform((value, ctx) => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    ctx.addIssue({ code: 'custom', message: 'not a parseable date string' });
    return z.NEVER;
  }
  return parsed;
});

/** Provider responses report reset timestamps either as epoch numbers (mixed
 *  seconds/ms) or as ISO strings — try the numeric form first. */
const timestampMsField = z.union([epochMsField, isoTimestampField]);

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
