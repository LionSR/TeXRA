/**
 * Chat export's input: a run's setup and its conversation's nodes, which
 * every format spec (markdown and the others) and text view consumes. The
 * nodes are the harness's format-agnostic `ExportNode`, projected from
 * transcript rows by `readCompletedRunConversation`; the HTML export path
 * uses `assembleTrace` instead.
 */

import type { AgentConfig, ExportNode } from '@texra-ai/harness/schemas';

/** The fields of the run's config an export's header shows. */
export type ExportConfig = Pick<
  AgentConfig,
  | 'agent'
  | 'model'
  | 'instruction'
  | 'inputFiles'
  | 'mediaFiles'
  | 'contextFiles'
  | 'outputFiles'
>;

/** A run's export input: its setup and its conversation's nodes. */
export interface ChatExportInput {
  readonly timestamp: string;
  readonly description?: string;
  readonly config: ExportConfig;
  readonly nodes: readonly ExportNode[];
}

// ============================================================
// Document metadata
// ============================================================

export interface DocumentMeta {
  date: string;
  agent?: string;
  model?: string;
  description?: string;
  instruction?: string;
  files: Array<{ label: string; value: string }>;
}
