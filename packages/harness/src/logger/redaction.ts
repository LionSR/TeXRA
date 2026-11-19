// Third-party imports
import { RegExp as EffectRegExp } from 'effect';

// Local imports
import { flattenError } from '@logger/formatLogData';
import type { ApiKeyProviderId } from '@texra-ai/llm';

const REDACTED = '[redacted]';

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi;
const JSON_STRING_PROPERTY_PATTERN =
  /("((?:[^"\\]|\\.)*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
const SECRET_FIELD_NAME_PATTERN = /API[_-]?KEY|TOKEN|SECRET|PASSWORD/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=_-]+/g;
const OPENAI_COMPATIBLE_API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const GOOGLE_STANDARD_API_KEY_PATTERN = /\bAIza[A-Za-z0-9_-]{20,}\b/g;
const GOOGLE_AUTH_API_KEY_PATTERN = /\bAQ\.[A-Za-z0-9._-]{20,}\b/g;
const XAI_API_KEY_PATTERN = /\bxai-[A-Za-z0-9_-]{12,}\b/g;

const OPENAI_COMPATIBLE_PATTERNS = [OPENAI_COMPATIBLE_API_KEY_PATTERN];

/**
 * The key shapes each configurable provider issues. The `satisfies` is the
 * point of the table: adding a provider to `API_KEY_PROVIDER_IDS` without
 * naming its key shape here is a compile error, so a new provider cannot ship
 * with its keys unredacted. Representative keys for each shape are the
 * redaction test's own fixture, not production data.
 */
const PROVIDER_KEY_PATTERNS_BY_PROVIDER = {
  openai: OPENAI_COMPATIBLE_PATTERNS,
  anthropic: OPENAI_COMPATIBLE_PATTERNS,
  google: [GOOGLE_STANDARD_API_KEY_PATTERN, GOOGLE_AUTH_API_KEY_PATTERN],
  xai: [XAI_API_KEY_PATTERN],
  deepseek: OPENAI_COMPATIBLE_PATTERNS,
  moonshot: OPENAI_COMPATIBLE_PATTERNS,
  dashscope: OPENAI_COMPATIBLE_PATTERNS,
  minimax: OPENAI_COMPATIBLE_PATTERNS,
  glm: OPENAI_COMPATIBLE_PATTERNS,
  meta: OPENAI_COMPATIBLE_PATTERNS,
  kimiCode: OPENAI_COMPATIBLE_PATTERNS,
} as const satisfies Record<ApiKeyProviderId, readonly RegExp[]>;

const PROVIDER_KEY_PATTERNS = [
  ...new Set(Object.values(PROVIDER_KEY_PATTERNS_BY_PROVIDER).flat()),
];

/**
 * Format an unowned failure for a fatal-error/startup dialog: full detail
 * (the stack when available) with any provider secret scrubbed. Every host's
 * "surface this to the user, then terminate" handler shares this formatting
 * so a crash dialog is never the one surface that shows a secret unredacted.
 */
export function formatFatalErrorDetail(error: unknown): string {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return redactSecrets(detail);
}

export function redactSecrets(text: string): string {
  let redacted = text
    .replaceAll(
      JSON_STRING_PROPERTY_PATTERN,
      (match, property: string, name: string) =>
        SECRET_FIELD_NAME_PATTERN.test(name)
          ? `${property}"${REDACTED}"`
          : match,
    )
    .replaceAll(
      SECRET_ASSIGNMENT_PATTERN,
      (_match, name: string) => `${name}=${REDACTED}`,
    )
    .replaceAll(BEARER_PATTERN, `Bearer ${REDACTED}`);

  for (const pattern of PROVIDER_KEY_PATTERNS) {
    redacted = redacted.replaceAll(pattern, REDACTED);
  }

  return redacted;
}

const EMAIL_LIKE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function maskIdentifierPart(part: string): string {
  return part ? `${part.at(0)}***` : '***';
}

/** `owner@example.edu` as `o***@e***.edu`: the first letter of each part and
 *  the top-level domain stay, so a reader can still tell two addresses
 *  apart. */
function maskEmailAddress(value: string): string {
  const atIndex = value.indexOf('@');
  const localPart = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  const domainParts = domain.split('.');
  const suffix = domainParts.length > 1 ? domainParts.at(-1) : undefined;
  const domainName = suffix ? domainParts.slice(0, -1).join('.') : domain;
  const maskedDomain = suffix
    ? `${maskIdentifierPart(domainName)}.${suffix}`
    : maskIdentifierPart(domainName);
  return `${maskIdentifierPart(localPart)}@${maskedDomain}`;
}

/** Mask every e-mail-like value in `text`. */
function redactEmailAddresses(text: string): string {
  return text.replaceAll(EMAIL_LIKE_PATTERN, (value) =>
    maskEmailAddress(value),
  );
}

/**
 * Replace each sensitive path prefix with `[path]`, whatever spelling its
 * separators have in the text: native or forward slashes, a mix of both, or
 * backslashes doubled once by JSON encoding and again by `util.format`
 * inspecting an object before a log entry is serialized. A prefix is matched
 * by its segments joined with any run of separators, so every encoding layer
 * is one pattern rather than one more enumerated spelling. Longer prefixes go
 * first, so a workspace inside the home directory is not cut at home.
 */
function redactPathPrefixes(
  text: string,
  ...prefixes: readonly (string | undefined)[]
): string {
  return prefixes
    .map((prefix) => prefix?.trim() ?? '')
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => prefix.split(/[\\/]+/))
    .toSorted(
      (a, b) => b.length - a.length || b.join('/').length - a.join('/').length,
    )
    .reduce((redacted, segments) => {
      // The POSIX root: a slash that starts a path, never one inside a URL
      // or a relative path.
      if (segments.every((segment) => segment === '')) {
        return redacted.replaceAll(/(?<![A-Za-z0-9:/])\//g, '[path]');
      }
      const pattern = segments.map(EffectRegExp.escape).join('[\\\\/]+');
      // A separator-terminated prefix already ends on a boundary; any other
      // must stop where the path does, never inside a longer sibling name.
      const boundary =
        segments.at(-1) === ''
          ? ''
          : `(?=$|[\\s\\\\/,:;!?\\])}'"]|\\.(?:$|\\s))`;
      return redacted.replaceAll(
        new RegExp(`${pattern}${boundary}`, 'g'),
        '[path]',
      );
    }, text);
}

/**
 * Text a host shows as a diagnostic (a health report, a log viewer, an
 * exported log) with what would identify the user masked: the home and
 * workspace path prefixes as `[path]`, e-mail addresses to their first
 * letters, and provider secrets as {@link redactSecrets} does. Paths go
 * first, so a path that holds an address or a key-shaped name is one
 * `[path]`. The caller names the paths because this module runs in
 * browser bundles too and cannot ask the OS for the home directory.
 */
export function redactDiagnostics(
  text: string,
  paths: { readonly home: string; readonly workspace: string | undefined },
): string {
  return redactSecrets(
    redactEmailAddresses(redactPathPrefixes(text, paths.workspace, paths.home)),
  );
}

/** Scrub a constructed JSON-shaped display value without changing its field structure.
 * Persisted execution records and provider inputs must retain their original values.
 *
 * A log payload reaches the write path rendered, but this walk's other
 * callers hand it raw values, so it is built for both. An `Error` in a raw
 * payload is flattened exactly as a render would (its fields are
 * non-enumerable, so the plain walk below would collapse it to `{}`),
 * through one `errors` map per call so a `cause` cycle terminates. An object
 * cycle meets `seen` and keeps the reference it already carries, so a later
 * render's `safe-stable-stringify` still reports it as `"[Circular]"`
 * instead of this walk recursing to a stack overflow.
 */
export function redactDisplayValue(value: unknown): unknown {
  return redactValue(value, new WeakMap(), new WeakSet());
}

/** {@link redactDisplayValue} over a record of fields, which stays a record. */
export function redactDisplayFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return redactFields(fields, new WeakMap(), new WeakSet([fields]));
}

function redactValue(
  value: unknown,
  errors: WeakMap<Error, Record<string, unknown>>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value instanceof Error)
    return redactValue(flattenError(value, errors), errors, seen);
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((field) => redactValue(field, errors, seen));
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  return redactFields(value, errors, seen);
}

/** An object's own fields, each redacted, a secret-named string field
 *  replaced whole. `seen` already holds `value`. */
function redactFields(
  value: object,
  errors: WeakMap<Error, Record<string, unknown>>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      typeof field === 'string' && SECRET_FIELD_NAME_PATTERN.test(key)
        ? REDACTED
        : redactValue(field, errors, seen),
    ]),
  );
}
