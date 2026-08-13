/**
 * Format specification and the shared render pipeline.
 *
 * A FormatSpec is a header template, a footer string, and a node-renderer
 * table. `renderDocument` runs the pandoc-style pipeline:
 *   raw messages → normalizeMessages() → ExportNode[] → FormatSpec → string
 */

import { normalizeConversationForExport as normalizeMessages } from '@agent/export/normalizeConversation';
import type {
  ChatExportInput,
  DocumentMeta,
  ExportConfig,
  ExportNode,
} from '@agent/export/schemas';
import { formatLocaleTimestamp } from '@utils/text/stringUtils';

/** Compile-time guarantee: every node kind has a renderer. */
export type NodeRenderers = {
  [K in ExportNode['kind']]: (node: Extract<ExportNode, { kind: K }>) => string;
};

export interface FormatSpec {
  header: (meta: DocumentMeta) => string;
  footer: string;
  nodes: NodeRenderers;
}

/** Metadata fields rendered in the document header. */
export const HEADER_FIELDS = [
  { key: 'date', label: 'Date' },
  { key: 'agent', label: 'Agent' },
  { key: 'model', label: 'Model' },
  { key: 'description', label: 'Summary' },
] as const satisfies readonly { key: keyof DocumentMeta; label: string }[];

function collectFiles(config: ExportConfig): Array<[string, string]> {
  const files: Array<[string, string]> = [];

  const addFiles = (label: string, values: string[] | undefined) => {
    if (values?.length) files.push([label, values.join(', ')]);
  };

  addFiles('Input files', config.inputFiles);
  addFiles('Media files', config.mediaFiles);
  addFiles('Context files', config.contextFiles);
  addFiles('Output files', config.outputFiles);

  return files;
}

function extractMeta(input: ChatExportInput): DocumentMeta {
  return {
    date: formatLocaleTimestamp(input.timestamp),
    agent: input.config.agent,
    model: input.config.model,
    description: input.description,
    instruction: input.config.instruction?.trim() || undefined,
    files: collectFiles(input.config),
  };
}

/** Render a node through a format spec's renderer table. */
function renderNode<K extends ExportNode['kind']>(
  node: Extract<ExportNode, { kind: K }>,
  renderers: NodeRenderers,
): string {
  return renderers[node.kind](node);
}

export function renderDocument(
  input: ChatExportInput,
  spec: FormatSpec,
): string {
  const meta = extractMeta(input);
  const nodes = normalizeMessages(input.messages);
  return [
    spec.header(meta),
    ...nodes.map((n) => renderNode(n, spec.nodes)),
    spec.footer,
  ]
    .filter(Boolean)
    .join('\n');
}
