const EMAIL_LIKE_ACCOUNT_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const EMAIL_LIKE_ACCOUNT_EXACT_PATTERN =
  /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

function maskIdentifierPart(part: string): string {
  return part ? `${part.at(0)}***` : '***';
}

export function formatCliAccountLabelForDisplay(accountLabel: string): string {
  const trimmed = accountLabel.trim();
  if (!EMAIL_LIKE_ACCOUNT_EXACT_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const atIndex = trimmed.indexOf('@');

  const localPart = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  const domainParts = domain.split('.');
  const suffix = domainParts.length > 1 ? domainParts.at(-1) : undefined;
  const domainName = suffix ? domainParts.slice(0, -1).join('.') : domain;
  const maskedDomain = suffix
    ? `${maskIdentifierPart(domainName)}.${suffix}`
    : maskIdentifierPart(domainName);
  return `${maskIdentifierPart(localPart)}@${maskedDomain}`;
}

export function redactEmailAccountLabelsForDisplay(text: string): string {
  return text.replaceAll(EMAIL_LIKE_ACCOUNT_PATTERN, (accountLabel) =>
    formatCliAccountLabelForDisplay(accountLabel),
  );
}
