import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';

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

type ApiKeyProviderId = (typeof API_KEY_PROVIDER_IDS)[number];

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
  openRouter: OPENAI_COMPATIBLE_PATTERNS,
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

/** Scrub a constructed JSON-shaped display value without changing its field structure.
 * Persisted execution records and provider inputs must retain their original values.
 */
export function redactDisplayValue<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactDisplayValue) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      typeof field === 'string' && SECRET_FIELD_NAME_PATTERN.test(key)
        ? REDACTED
        : redactDisplayValue(field),
    ]),
  ) as T;
}
