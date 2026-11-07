// Local imports - tool result schemas
import { Schema } from 'effect';

import {
  type FileReference,
  type ToolFact,
  type ToolFileAttachment,
  type ToolResult,
  ToolResultSchema,
} from '@shared/schemas';

/**
 * Result from extracting attachments from a tool result.
 * Simple interface - no runtime validation needed for this structure.
 */
interface ExtractedToolAttachments {
  /** Extracted file attachments with binary data. */
  attachments: readonly ToolFileAttachment[];
  /** Sanitized result payload without binary data or facts. */
  sanitizedResult: ToolResult;
  /** The facts an executed result states about its run, which commit as
   *  rows beside its settlement, never on the stored result. */
  facts: readonly ToolFact[];
}

/**
 * Extracts file attachments from a tool result and returns a typed payload.
 * Binary data (base64Data, bytes) is stripped from the result.
 *
 * Uses the source-level `ToolResultSchema` discriminator; tools declare
 * success vs error before this projection sees the result.
 *
 * @param result - Raw tool result, possibly containing binary data.
 * @param checkFacts - Throws on a fact the calling tool may not state.
 * @returns Extracted attachments and typed payload without binary data.
 */
export function extractToolAttachments(
  result: ToolResult,
  checkFacts: (facts: readonly ToolFact[]) => void = () => undefined,
): ExtractedToolAttachments {
  // The decode IS the field whitelist: `ToolResultSchema` keeps no unknown
  // keys, so every undeclared key is already stripped here. Re-listing the declared
  // fields by hand would only add a place for a newly declared field to go
  // missing before it reaches `formatToolResultAsText`.
  const parsed = Schema.decodeUnknownSync(ToolResultSchema)(result);

  // No binary-bearing field exists on the error branch of the schema
  // (output/edits/files are all `Schema.Undefined` there).
  if (parsed.status === 'error')
    return { attachments: [], facts: [], sanitizedResult: parsed };

  const { files, facts = [], ...rest } = parsed;
  checkFacts(facts);
  const attachments: readonly ToolFileAttachment[] = files ?? [];

  return {
    attachments,
    facts,
    sanitizedResult: {
      ...rest,
      // Binary payloads (base64Data/bytes) are the one thing the schema keeps
      // and this projection must not: `FileReferenceSchema` is a loose object.
      ...(attachments.length > 0
        ? {
            files: attachments.map((file): FileReference => ({
              path: file.path,
              mimeType: file.mimeType,
              ...(file.description ? { description: file.description } : {}),
            })),
          }
        : {}),
    },
  };
}
