const PROVIDER_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^(sk-?)?(x{3,}|\*{3,}|\.{3,}|<.*>|your[- _]?(?:api[- _]?)?key)/i,
  /^(?:api[- _]?)?key[- _]?here$/i,
  /^placeholder$/i,
  /^example$/i,
];

const GITHUB_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^(?:sk-?)?(?:x{3,}|\*{3,}|\.{3,}|<.*>|your[- _]?.*)$/i,
  /^(?:(?:api|github)[- _]?)?(?:key|token)[- _]?here$/i,
  /^placeholder$/i,
  /^example$/i,
];

/** Reject common masked/example values before they enter the secret store. */
export function looksLikeCredentialPlaceholder(
  value: string,
  kind: 'provider' | 'github' = 'provider',
): boolean {
  const patterns =
    kind === 'github'
      ? GITHUB_PLACEHOLDER_PATTERNS
      : PROVIDER_PLACEHOLDER_PATTERNS;
  return value.length < 8 || patterns.some((pattern) => pattern.test(value));
}
