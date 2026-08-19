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

export function assertSubscriptionUsageResponse(response: Response): void {
  if (!response.ok) throw new SubscriptionUsageHttpError(response.status);
}

export function asObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  let parsed = Number.NaN;
  if (typeof value === 'number') parsed = value;
  if (typeof value === 'string' && value.trim() !== '') parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function stringField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

export function numberField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(object?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function timestampMs(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined) {
    if (numeric < 0) return undefined;
    return Math.trunc(numeric < 100_000_000_000 ? numeric * 1000 : numeric);
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function timestampField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const parsed = timestampMs(object?.[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
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
