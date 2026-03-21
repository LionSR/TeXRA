// Third-party imports
import PostalMime from 'postal-mime';
import type { Address, Email } from 'postal-mime';

/**
 * Parse an EML file's raw text content into a human-readable plain-text representation.
 *
 * Extracts key headers (From, To, CC, Subject, Date) and the text body.
 * When no plain-text part exists, falls back to a simplified version of the HTML body.
 * Attachment filenames are listed at the end.
 */
export async function parseEmlToText(rawEml: string): Promise<string> {
  const email = await PostalMime.parse(rawEml);
  return formatEmail(email);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatEmail(email: Email): string {
  const sections: string[] = [];

  // -- Headers --------------------------------------------------------------
  const headerLines: string[] = [];

  if (email.from) {
    headerLines.push(`From: ${formatAddress(email.from)}`);
  }
  if (email.to?.length) {
    headerLines.push(`To: ${email.to.map(formatAddress).join(', ')}`);
  }
  if (email.cc?.length) {
    headerLines.push(`CC: ${email.cc.map(formatAddress).join(', ')}`);
  }
  if (email.date) {
    headerLines.push(`Date: ${email.date}`);
  }
  if (email.subject) {
    headerLines.push(`Subject: ${email.subject}`);
  }
  if (email.messageId) {
    headerLines.push(`Message-ID: ${email.messageId}`);
  }

  if (headerLines.length > 0) {
    sections.push(headerLines.join('\n'));
  }

  // -- Body -----------------------------------------------------------------
  const body = email.text ?? stripHtml(email.html ?? '');
  if (body.trim()) {
    sections.push(body.trim());
  }

  // -- Attachments ----------------------------------------------------------
  const attachmentNames = email.attachments
    .map((a) => a.filename)
    .filter(Boolean);
  if (attachmentNames.length > 0) {
    sections.push(
      `Attachments:\n${attachmentNames.map((n) => `  - ${n}`).join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

function formatAddress(addr: Address): string {
  if (addr.group) {
    const members = addr.group.map(formatAddress).join(', ');
    return addr.name ? `${addr.name}: ${members}` : members;
  }
  return addr.name ? `${addr.name} <${addr.address}>` : (addr.address ?? '');
}

/**
 * Minimal HTML-to-text conversion: strip tags and decode common entities.
 * This is intentionally lightweight — we only hit this path when no text/plain
 * part exists in the email.
 */
function stripHtml(html: string): string {
  return html
    .replaceAll(/<br\s*\/?>/gi, '\n')
    .replaceAll(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll(/&nbsp;/gi, ' ')
    .replaceAll(/&amp;/gi, '&')
    .replaceAll(/&lt;/gi, '<')
    .replaceAll(/&gt;/gi, '>')
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&#039;/gi, "'")
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}
