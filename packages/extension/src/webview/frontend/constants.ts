// Local imports - shared schemas
import {
  AgentCategory,
  SessionTypeSchema,
  type DocumentFileType,
  type MultipleDocumentFileType,
  type SessionType,
} from '@shared/schemas';

// Local constants - session types. SessionTypeSchema aliases
// AgentCategorySchema, so name the members directly — positional
// destructuring of `.options` would silently swap on enum-order changes.
export const SESSION_TYPES = {
  TOOL_USE: AgentCategory.ToolUse,
  WORKFLOW: AgentCategory.Workflow,
} as const;

export type { SessionType, DocumentFileType, MultipleDocumentFileType };

export function parseSessionType(
  sessionType: string | null | undefined,
): SessionType | undefined {
  return SessionTypeSchema.optional().catch(undefined).parse(sessionType);
}
