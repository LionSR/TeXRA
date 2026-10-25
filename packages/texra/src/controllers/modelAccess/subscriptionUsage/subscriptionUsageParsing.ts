import {
  Duration,
  Effect,
  Number as Num,
  Predicate,
  Result,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { SubscriptionUsageWindow } from '@texra/shared/model/subscriptionUsage';
import type { SchemaAST } from 'effect';

import type { Cause } from 'effect';
import type { HttpClientError } from 'effect/http';

export type JsonObject = Record<string, unknown>;

export interface ParsedSubscriptionUsage {
  readonly planName?: string;
  readonly windows: readonly SubscriptionUsageWindow[];
}

/**
 * The one subscription-usage request every provider adapter makes. Only the
 * URL and headers differ per provider, so the GET, the deadline and the
 * non-OK status assertion live here; the decoded body goes back to the
 * adapter's own `parseX`. `timeoutMs` is one `Effect.timeout` over the request
 * and the body read. The failure channel is the client's own, so the service
 * classifies on its reason (`StatusCodeError` 401/403 -> refused,
 * `DecodeError` over a `SyntaxError` -> malformed body).
 */
export function fetchSubscriptionUsage(request: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
}): Effect.Effect<
  unknown,
  HttpClientError.HttpClientError | Cause.TimeoutError,
  HttpClient.HttpClient
> {
  return HttpClient.get(request.url, { headers: request.headers }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout(Duration.millis(request.timeoutMs)),
  );
}

export function asObject(value: unknown): JsonObject | undefined {
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

/** Pick the first field, by alias, that parses against `schema`. Every
 *  subscription-usage adapter reads the same provider concept under several
 *  different wire spellings (`reset_at` / `resets_at` / `resetTime` / …), so
 *  the alias fallback lives once here instead of once per detector. */
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

export function stringField(
  object: JsonObject | undefined,
  ...keys: readonly string[]
): string | undefined {
  return pickField(nonBlankString, object, keys);
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
