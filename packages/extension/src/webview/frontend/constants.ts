// Local imports - shared schemas
import {
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

export function parseSessionType(
  sessionType: string | null | undefined,
): SessionType | undefined {
  return SessionTypeSchema.optional().catch(undefined).parse(sessionType);
}
