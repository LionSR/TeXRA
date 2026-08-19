// Third-party imports
import PostalMime from 'postal-mime';

// Local imports
import { createHtmlToMarkdown } from '@tools/htmlToMarkdown';

import type { Address, Attachment, Email } from 'postal-mime';

/** An image extracted from the email (inline or attached). */
export interface EmlImageAttachment {
  /** Original filename, or a generated one like "image-1.png" */
  filename: string;
  /** MIME type (e.g. "image/png") */
  mimeType: string;
  /** Raw image bytes */
  bytes: Uint8Array;
}

interface EmlParseResult {
  /** Human-readable representation of the email (plain text, or Markdown when falling back from an HTML-only body) */
  text: string;
  /** Image attachments extracted from the email */
  images: EmlImageAttachment[];
}

interface AttachmentPartition {
  images: EmlImageAttachment[];
  otherNames: string[];
}

const IMAGE_MIME_PREFIX = 'image/';

const turndownService = createHtmlToMarkdown();

/**
 * Parse an EML file's raw text content into a human-readable representation,
 * and extract any image attachments.
 *
 * Extracts key headers (From, To, CC, Subject, Date) and the text body.
 * When no plain-text part exists, falls back to a Markdown conversion of the HTML body.
 * Non-image attachment filenames are listed at the end of the text.
 */
export async function parseEml(rawEml: string): Promise<EmlParseResult> {
  const email = await PostalMime.parse(rawEml);
  const partition = partitionAttachments(email.attachments);
  const text = formatEmail(email, partition);
  return { text, images: partition.images };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatEmail(
  email: Email,
  { images, otherNames }: AttachmentPartition,
): string {
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
  // Falls back to a Markdown conversion of the HTML body (preserving lists,
  // links, and emphasis) when no text/plain part exists.
  const body = (
    email.text ?? turndownService.turndown(email.html ?? '')
  ).trim();
  if (body) {
    sections.push(body);
  }

  // -- Image attachments (returned as binary, noted in text) ----------------
  if (images.length > 0) {
    sections.push(
      `Images (attached for visual inspection):\n${images.map((img) => `  - ${img.filename}`).join('\n')}`,
    );
  }

  // -- Non-image attachments (listed by name only) --------------------------
  if (otherNames.length > 0) {
    sections.push(
      `Other attachments:\n${otherNames.map((n) => `  - ${n}`).join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Image extraction
// ---------------------------------------------------------------------------

function partitionAttachments(attachments: Attachment[]): AttachmentPartition {
  const images: EmlImageAttachment[] = [];
  const otherNames: string[] = [];
  let unnamedCounter = 0;

  for (const att of attachments) {
    if (!att.mimeType.startsWith(IMAGE_MIME_PREFIX)) {
      if (att.filename) otherNames.push(att.filename);
      continue;
    }

    const bytes = toUint8Array(att.content);
    if (bytes.byteLength === 0) continue;

    const filename =
      att.filename ||
      `image-${++unnamedCounter}.${extensionFromMime(att.mimeType)}`;
    images.push({ filename, mimeType: att.mimeType, bytes });
  }

  return { images, otherNames };
}

function toUint8Array(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  // base64-encoded string — Buffer.from decodes in place, wrap as Uint8Array view
  return new Uint8Array(Buffer.from(content, 'base64'));
}

const MIME_SUBTYPE_TO_EXT: Record<string, string> = {
  jpeg: 'jpg',
  'svg+xml': 'svg',
  tiff: 'tif',
};

function extensionFromMime(mimeType: string): string {
  const sub = mimeType.split('/')[1] ?? 'bin';
  return MIME_SUBTYPE_TO_EXT[sub] ?? sub;
}

function formatAddress(addr: Address): string {
  if (addr.group) {
    const members = addr.group.map(formatAddress).join(', ');
    return addr.name ? `${addr.name}: ${members}` : members;
  }
  return addr.name ? `${addr.name} <${addr.address}>` : (addr.address ?? '');
}
