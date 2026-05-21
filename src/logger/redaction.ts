const REDACTED = '[redacted]';

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=_-]+/g;
const PROVIDER_KEY_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,})\b/g;

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
      SECRET_ASSIGNMENT_PATTERN,
      (_match, name: string) => `${name}=${REDACTED}`,
    )
    .replaceAll(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replaceAll(PROVIDER_KEY_PATTERN, REDACTED);

  for (const prefix of prefixes) {
    redacted = redacted.replaceAll(prefix, '[path]');
  }

  return redacted;
}
