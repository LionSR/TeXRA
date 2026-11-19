/**
 * What a coding plan's quota endpoint reports: one GET per plan, at the host
 * its routes already use, and the provider's loosely shaped body read into
 * named usage windows. The caller keeps the cache and the presentation, and
 * classifies a failure on the HTTP client's own reason (`StatusCodeError`
 * 401/403 is a refused key, `DecodeError` over a `SyntaxError` a malformed
 * body).
 */
import {
  absurd,
  Duration,
  Effect,
  Number as Num,
  Predicate,
  Redacted,
  Result,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { Cause, SchemaAST } from 'effect';
import type { HttpClientError } from 'effect/http';

import { GLM_BASE_URLS } from './providerPlugins.js';
import { KIMI_CODE_BASE_URL } from './providers.js';

/** One quota window of a plan, as a share of its limit. */
export interface PlanUsageWindow {
  /** The provider's own name for the window (`five_hour`, `glm-4.6:weekly`). */
  readonly name: string;
  readonly percentUsed: number;
  readonly percentRemaining: number;
  /** When the window resets, in epoch milliseconds. */
  readonly resetAt?: number;
}

/** A plan's reported usage. No window means the body named none it reads. */
export interface PlanUsage {
  /** The plan's tier as the provider names it, when the body says. */
  readonly planName?: string;
  readonly windows: readonly PlanUsageWindow[];
}

/** Which plan to ask, and for GLM which platform its key belongs to. */
export type PlanUsageRequest =
  | { readonly plan: 'kimiCode' }
  | { readonly plan: 'glm'; readonly region: 'china' | 'international' };

/** The one deadline over a usage request and its body read. */
const REQUEST_TIMEOUT = Duration.seconds(15);

/**
 * Fetch and read a plan's usage with its API key. The GLM quota endpoint is
 * on the same host as the region's Responses endpoint.
 */
export function fetchPlanUsage(
  request: PlanUsageRequest,
  apiKey: Redacted.Redacted<string>,
): Effect.Effect<
  PlanUsage,
  HttpClientError.HttpClientError | Cause.TimeoutError,
  HttpClient.HttpClient
> {
  const key = Redacted.value(apiKey);
  const { url, headers, parse } =
    request.plan === 'kimiCode'
      ? {
          url: `${KIMI_CODE_BASE_URL}/usages`,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${key}`,
          },
          parse: parseKimiCodeUsage,
        }
      : request.plan === 'glm'
        ? {
            url: new URL(
              '/api/monitor/usage/quota/limit',
              GLM_BASE_URLS[request.region],
            ).href,
            headers: {
              Accept: 'application/json',
              'Accept-Language': 'en-US,en',
              Authorization: key,
              'Content-Type': 'application/json',
            },
            parse: parseGlmCodingPlanUsage,
          }
        : absurd<never>(request);
  return HttpClient.get(url, { headers }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.map(parse),
  );
}

// ============================================================================
// Loose wire fields
// ============================================================================

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return Predicate.isObject(value) ? value : undefined;
}

const nonBlankString = Schema.Trim.check(Schema.isMinLength(1));

/** A loosely-typed wire number: a real number, or a non-blank numeric string
 *  (provider responses mix both for the same logical field). A blank string
 *  is refused rather than read as `Number('') === 0`. */
const looseFiniteNumber = Schema.Union([
  Schema.Finite,
  nonBlankString.pipe(
    Schema.decodeTo(Schema.Finite, {
      decode: SchemaGetter.Number(),
      encode: SchemaGetter.String(),
    }),
  ),
]);

const timestampIssue = (
  message: string,
  value: unknown,
  options: SchemaAST.ParseOptions,
) => Effect.fail(new SchemaIssue.InvalidValue({ message }, value, options));

/** A wire timestamp expressed as an epoch number (seconds or milliseconds,
 *  whichever `looseFiniteNumber` resolves to) or an ISO 8601 (or otherwise
 *  `Date.parse`-able) string, normalized to epoch ms. A value that parses as
 *  a number commits to the numeric interpretation — a negative epoch is
 *  rejected outright rather than falling through to `Date.parse`, which
 *  accepts some non-ISO numeric-looking strings as dates (`Date.parse('-1')`
 *  resolves to 2001-01-01). */
const timestampMsField = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformEffect((value, options) => {
      const numeric = Schema.decodeUnknownResult(looseFiniteNumber)(value);
      if (Result.isSuccess(numeric)) {
        if (numeric.success < 0) {
          return timestampIssue('negative epoch timestamp', value, options);
        }
        return Effect.succeed(
          Math.trunc(
            numeric.success < 100_000_000_000
              ? numeric.success * 1000
              : numeric.success,
          ),
        );
      }
      if (typeof value !== 'string') {
        return timestampIssue('not a timestamp', value, options);
      }
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) {
        return timestampIssue('not a parseable date string', value, options);
      }
      return Effect.succeed(parsed);
    }),
    // A provider response is read one way; nothing encodes a timestamp back.
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
);

/** Pick the first field, by alias, that parses against `schema`. Each plan
 *  reads the same concept under several wire spellings (`reset_at` /
 *  `resets_at` / `resetTime` / …). */
function pickField<Value>(
  schema: Schema.Codec<Value, unknown>,
  object: JsonObject | undefined,
  keys: readonly string[],
): Value | undefined {
  for (const key of keys) {
    const result = Schema.decodeUnknownResult(schema)(object?.[key]);
    if (Result.isSuccess(result)) return result.success;
  }
  return undefined;
}

function stringField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): string | undefined {
  return pickField(nonBlankString, object, keys);
}

function numberField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): number | undefined {
  return pickField(looseFiniteNumber, object, keys);
}

function timestampField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): number | undefined {
  return pickField(timestampMsField, object, keys);
}

function usageWindow(
  name: string,
  usage: { readonly used?: number; readonly remaining?: number },
  resetAt: number | undefined,
): PlanUsageWindow | undefined {
  let percentUsed: number | undefined;
  if (usage.used !== undefined) {
    percentUsed = Num.clamp(usage.used, { minimum: 0, maximum: 100 });
  } else if (usage.remaining !== undefined) {
    percentUsed =
      100 - Num.clamp(usage.remaining, { minimum: 0, maximum: 100 });
  }
  if (percentUsed === undefined) return undefined;
  return {
    name,
    percentUsed,
    percentRemaining: 100 - percentUsed,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

// ============================================================================
// Kimi Code
// ============================================================================

function kimiWindow(name: string, value: unknown): PlanUsageWindow | undefined {
  const item = asObject(value);
  const detail = asObject(item?.detail) ?? item;
  const limit = numberField(detail, 'limit', 'max_value_usd', 'maxValueUsd');
  const remaining = numberField(detail, 'remaining');
  let used = numberField(detail, 'used', 'used_value_usd', 'usedValueUsd');
  if (used === undefined && limit !== undefined && remaining !== undefined) {
    used = Math.max(0, limit - remaining);
  }
  if (used === undefined || limit === undefined || limit <= 0) {
    return undefined;
  }
  return usageWindow(
    name,
    { used: (used / limit) * 100 },
    timestampField(detail, 'resetTime', 'resets_at', 'reset_at'),
  );
}

function parseKimiCodeUsage(body: unknown): PlanUsage {
  const root = asObject(body);
  const data = asObject(root?.data) ?? root;
  const windows = new Map<string, PlanUsageWindow>();
  const add = (name: string, value: unknown) => {
    const window = kimiWindow(name, value);
    if (window) windows.set(name, window);
  };
  const limits = data?.limits;

  if (Array.isArray(limits)) {
    for (const [index, item] of limits.entries()) {
      const rawName = stringField(asObject(item), 'name', 'type', 'quota_type');
      add(rawName ?? (index === 0 ? 'five_hour' : `limit_${index + 1}`), item);
    }
  } else {
    for (const [name, value] of Object.entries(asObject(limits) ?? {})) {
      add(name, value);
    }
  }

  add('weekly_limit', data?.usage);

  // Older responses named the two quota records directly and reported USD
  // usage rather than limit/remaining counts.
  add('five_hour', data?.quota_5_hour);
  add('seven_day', data?.quota_7_day);

  return {
    planName: stringField(data, 'plan', 'plan_name', 'account_status'),
    windows: [...windows.values()],
  };
}

// ============================================================================
// GLM Coding Plan
// ============================================================================

interface GlmLimitEntry {
  readonly value: JsonObject;
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
  windows: Map<string, PlanUsageWindow>,
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
    timestampField(
      object,
      'current_interval_end_time',
      'currentIntervalEndTime',
      'interval_end_time',
    ),
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
    timestampField(
      object,
      'weekly_end_time',
      'weeklyEndTime',
      'current_weekly_end_time',
    ),
  );
  if (weekly) windows.set(weekly.name, weekly);

  const modelRemains = object.model_remains ?? object.modelRemains;
  if (Array.isArray(modelRemains)) {
    for (const modelRemain of modelRemains) {
      const modelName = stringField(
        asObject(modelRemain),
        'model_name',
        'modelName',
      );
      addRemainingWindows(
        windows,
        modelRemain,
        modelName ? `${modelName}:` : 'model:',
      );
    }
  } else {
    for (const [modelName, remains] of Object.entries(
      asObject(modelRemains) ?? {},
    )) {
      addRemainingWindows(windows, remains, `${modelName}:`);
    }
  }
}

function parseGlmCodingPlanUsage(body: unknown): PlanUsage {
  const root = asObject(body);
  if (root?.success === false) return { windows: [] };
  const data = asObject(root?.data) ?? root;
  const windows = new Map<string, PlanUsageWindow>();
  const classified = classifyGlmLimits(
    Array.isArray(data?.limits) ? data.limits : [],
  );

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
      entry.resetAt,
    );
    if (window) windows.set(name, window);
  }

  addRemainingWindows(windows, data);

  return {
    planName: stringField(data, 'level', 'plan', 'plan_name'),
    windows: [...windows.values()],
  };
}
