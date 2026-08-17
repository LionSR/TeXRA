const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^(?:sk-?)?(?:x{3,}|\*{3,}|\.{3,}|<.*>|your[- _]?.*)$/i,
  /^(?:(?:api|github)[- _]?)?(?:key|token)[- _]?here$/i,
  /^placeholder$/i,
  /^example$/i,
];

/** Reject common masked/example values before they enter the secret store. */
export function looksLikeCredentialPlaceholder(value: string): boolean {
  return (
    value.length < 8 ||
    PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))
  );
}
