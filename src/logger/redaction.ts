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

interface ProviderKeyRedactionRule {
  readonly examples: readonly string[];
  readonly patterns: readonly RegExp[];
}

const OPENAI_COMPATIBLE_REDACTION = {
  examples: ['sk-provider-redaction-example-1234567890abcdef'],
  patterns: [OPENAI_COMPATIBLE_API_KEY_PATTERN],
} as const satisfies ProviderKeyRedactionRule;

export const PROVIDER_KEY_REDACTION_RULES = {
  openai: {
    examples: ['sk-proj-redaction-example-1234567890abcdef'],
    patterns: [OPENAI_COMPATIBLE_API_KEY_PATTERN],
  },
  anthropic: {
    examples: ['sk-ant-api03-redaction-example-1234567890abcdef'],
    patterns: [OPENAI_COMPATIBLE_API_KEY_PATTERN],
  },
  openRouter: {
    examples: ['sk-or-v1-redaction-example-1234567890abcdef'],
    patterns: [OPENAI_COMPATIBLE_API_KEY_PATTERN],
  },
  google: {
    examples: [
      'AIzaSyRedactionExample1234567890abcdef',
      'AQ.AbRedactionExample1234567890abcdef',
    ],
    patterns: [GOOGLE_STANDARD_API_KEY_PATTERN, GOOGLE_AUTH_API_KEY_PATTERN],
  },
  xai: {
    examples: ['xai-redaction-example-1234567890abcdef'],
    patterns: [XAI_API_KEY_PATTERN],
  },
  deepseek: OPENAI_COMPATIBLE_REDACTION,
  moonshot: {
    examples: ['sk-kimi-redaction-example-1234567890abcdef'],
    patterns: [OPENAI_COMPATIBLE_API_KEY_PATTERN],
  },
  dashscope: {
    examples: [
      'sk-redaction-example-1234567890abcdef',
      'sk-ws-redaction-example-1234567890abcdef',
    ],
    patterns: [OPENAI_COMPATIBLE_API_KEY_PATTERN],
  },
  minimax: {
    examples: ['sk-cp-redaction-example-1234567890abcdef'],
    patterns: [OPENAI_COMPATIBLE_API_KEY_PATTERN],
  },
  glm: OPENAI_COMPATIBLE_REDACTION,
  meta: OPENAI_COMPATIBLE_REDACTION,
  kimiCode: OPENAI_COMPATIBLE_REDACTION,
} as const satisfies Record<ApiKeyProviderId, ProviderKeyRedactionRule>;

const PROVIDER_KEY_PATTERNS = [
  ...new Set(
    Object.values(PROVIDER_KEY_REDACTION_RULES).flatMap(
      (rule) => rule.patterns,
    ),
  ),
];

export interface LogRedactionOptions {
  readonly homeDir?: string | undefined;
  readonly workspacePath?: string | undefined;
}

export function redactSecrets(
  text: string,
  options: LogRedactionOptions = {},
): string {
  const prefixes = [options.workspacePath, options.homeDir]
    .filter((prefix): prefix is string => Boolean(prefix))
    .sort((a, b) => b.length - a.length);

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

  for (const prefix of prefixes) {
    redacted = redacted.replaceAll(prefix, '[path]');
  }

  return redacted;
}
