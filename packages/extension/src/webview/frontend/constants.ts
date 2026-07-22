// Local imports - shared schemas
import {
  DocumentFileTypeSchema,
  MULTIPLE_DOCUMENT_FILE_TYPES,
  SessionTypeSchema,
  type DocumentFileType,
  type MultipleDocumentFileType,
  type SessionType,
} from '@shared/schemas';

const [toolUseSessionType, workflowSessionType] = SessionTypeSchema.options;

// Local constants - session types
export const SESSION_TYPES = {
  TOOL_USE: toolUseSessionType,
  WORKFLOW: workflowSessionType,
} as const;

export type { SessionType, DocumentFileType, MultipleDocumentFileType };

export const DOCUMENT_FILE_TYPES = DocumentFileTypeSchema.options;
export { MULTIPLE_DOCUMENT_FILE_TYPES };

/** Narrows a broader file-type value (e.g. `CurrentFileType`) to `DocumentFileType`. */
export function isDocumentFileType(value: string): value is DocumentFileType {
  return (DOCUMENT_FILE_TYPES as readonly string[]).includes(value);
}

/** Narrows a broader file-type value (e.g. `ExtendedDocumentFileType`) to `MultipleDocumentFileType`. */
export function isMultipleDocumentFileType(
  value: string,
): value is MultipleDocumentFileType {
  return (MULTIPLE_DOCUMENT_FILE_TYPES as readonly string[]).includes(value);
}

export function parseSessionType(
  sessionType: string | null | undefined,
): SessionType | undefined {
  return SessionTypeSchema.optional().catch(undefined).parse(sessionType);
}
