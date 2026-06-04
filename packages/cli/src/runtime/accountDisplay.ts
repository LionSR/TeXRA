const EMAIL_LIKE_ACCOUNT_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function maskIdentifierPart(part: string): string {
  return part ? `${part.at(0)}***` : '***';
}

export function formatCliAccountLabelForDisplay(accountLabel: string): string {
  return accountLabel.trim();
}

function redactEmailAccountLabel(accountLabel: string): string {
  const atIndex = accountLabel.indexOf('@');
  const localPart = accountLabel.slice(0, atIndex);
  const domain = accountLabel.slice(atIndex + 1);
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
    redactEmailAccountLabel(accountLabel),
  );
}
