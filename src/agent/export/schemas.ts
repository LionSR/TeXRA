/**
 * Format-agnostic intermediate representation types for chat export.
 *
 * These describe the `ExportNode` produced by normalization and consumed by
 * every format spec (markdown, LaTeX). The HTML export path uses
 * `assembleTrace` instead. They are host-neutral and carry no
 * provider-specific types — the command-layer export package imports these
 * without pulling in `openai/*`, `@agent/modelHandlers/openai/*`, or
 * `@google/genai`.
 *
 * These types describe an in-process representation rather than a validation
 * boundary. The one cross-module dependency is the canonical web-search
 * result type from `@agent/types/ServerTools`, whose provider SDK imports are
 * type-only, so the neutrality note above still holds.
 */

import type { WebSearchResult } from '@agent/types/ServerTools';
import type { MediaAttachmentKind } from '@shared/schemas';

// ============================================================
// Export configuration (caller-supplied)
// ============================================================

export interface ExportConfig {
  agent?: string;
  model?: string;
  instruction?: string;
  inputFiles?: string[];
  mediaFiles?: string[];
  contextFiles?: string[];
  outputFiles?: string[];
}

export interface ChatExportInput {
  timestamp: string;
  description?: string;
  config: ExportConfig;
  messages: unknown[];
}

// ============================================================
// Intermediate representation — format-agnostic
// ============================================================

/**
 * One rendered search hit in the exported document: the title/url projection
 * of the canonical provider result entry ({@link WebSearchResult} in
 * `@agent/types/ServerTools`). Domain never reaches the export IR.
 */
type ExportWebSearchResult = Pick<
  WebSearchResult['results'][number],
  'title' | 'url'
>;

/**
 * Attachment kinds a renderer must be able to label. Kept in step with the
 * canonical {@link MediaAttachmentKind} vocabulary: the transcript row and the
 * exported document describe the same attachment, so a kind added there must
 * also gain a label in every format spec.
 */
export type ExportAttachmentType = MediaAttachmentKind;

export type UserPart =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachmentType: ExportAttachmentType };

export type ExportNode =
  | { kind: 'user-message'; parts: UserPart[] }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-call'; name: string; input: string }
  | { kind: 'tool-result'; text: string }
  | { kind: 'web-search'; query: string }
  | { kind: 'web-search-results'; results: ExportWebSearchResult[] }
  | {
      kind: 'web-fetch';
      url?: string;
      title?: string;
      content?: string;
    };

// ============================================================
// Document metadata
// ============================================================

export interface DocumentMeta {
  date: string;
  agent?: string;
  model?: string;
  description?: string;
  instruction?: string;
  files: Array<[string, string]>;
}
