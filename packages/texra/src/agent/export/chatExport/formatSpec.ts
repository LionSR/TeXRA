/**
 * Format specification and the shared render pipeline of the chat export,
 * which renders a conversation as Markdown (`./markdownSpec`) or LaTeX
 * (`./latexSpec`).
 *
 * A FormatSpec is a header template, a footer string, and a node-renderer
 * table. `renderDocument` runs the pandoc-style pipeline:
 *   ExportNode[] → FormatSpec → string
 * Adding a new node kind means adding one entry per renderer table. The
 * formatters are host-neutral: all platform wiring lives in the caller.
 */

import type {
  ChatExportInput,
  DocumentMeta,
  ExportConfig,
} from '@texra/agent/export/schemas';
import type {
  ExportNode,
  MediaAttachmentKind,
} from '@texra-ai/harness/schemas';

/** Compile-time guarantee: every node kind has a renderer. */
export type NodeRenderers = {
  [K in ExportNode['kind']]: (node: Extract<ExportNode, { kind: K }>) => string;
};

export interface FormatSpec {
  header: (meta: DocumentMeta) => string;
  footer: string;
  nodes: NodeRenderers;
}

/** The heading every export opens with. */
export const EXPORT_TITLE = 'TeXRA Chat Export';

/** What stands in for a media attachment of a user message. */
export const ATTACHMENT_LABELS = Object.freeze({
  image: 'Image attachment',
  document: 'Document attachment',
} as const satisfies Record<MediaAttachmentKind, string>);

/** Metadata fields rendered in the document header. */
export const HEADER_FIELDS = Object.freeze([
  Object.freeze({ key: 'date', label: 'Date' }),
  Object.freeze({ key: 'agent', label: 'Agent' }),
  Object.freeze({ key: 'model', label: 'Model' }),
  Object.freeze({ key: 'description', label: 'Summary' }),
] as const satisfies readonly { key: keyof DocumentMeta; label: string }[]);

function collectFiles(
  config: ExportConfig,
): Array<{ label: string; value: string }> {
  const files: Array<{ label: string; value: string }> = [];

  const addFiles = (label: string, values: readonly string[] | undefined) => {
    if (values?.length) files.push({ label, value: values.join(', ') });
  };

  addFiles('Input files', config.inputFiles);
  addFiles('Media files', config.mediaFiles);
  addFiles('Context files', config.contextFiles);
  addFiles('Output files', config.outputFiles);

  return files;
}

function extractMeta(input: ChatExportInput): DocumentMeta {
  return {
    date: new Date(input.timestamp).toLocaleString(),
    agent: input.config.label,
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
  return [
    spec.header(extractMeta(input)),
    ...input.nodes.map((n) => renderNode(n, spec.nodes)),
    spec.footer,
  ]
    .filter(Boolean)
    .join('\n');
}
