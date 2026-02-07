/**
 * Export BibTeX entries from Zotero via Better BibTeX JSON-RPC API.
 *
 * Requires the Better BibTeX plugin to be installed in Zotero.
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 */

// Third-party imports
import { z } from 'zod';

// Local imports - core
import { ToolError } from '@tools/result';
import { pluralize } from '@tools/utils';
import { defineTool } from '@tools/core/define';

// Local imports - zotero
import { callBetterBibTeX, getZoteroPort } from './bbtClient';

const ZOTERO_EXPORT_TIMEOUT_MS = 30_000; // 30 s

const ZoteroExportInputSchema = z.strictObject({
  citekeys: z
    .array(z.string().min(1))
    .min(1, 'At least one citation key must be provided.')
    .max(50, 'Maximum 50 citation keys can be exported at once.')
    .describe('List of Better BibTeX citation keys to export.'),
  format: z
    .enum(['bibtex', 'biblatex', 'json'])
    .describe('Export format. Defaults to biblatex.')
    .nullish(),
  library: z
    .string()
    .describe(
      'Optional library ID. Omit to search in My Library, or use "*" for all.',
    )
    .nullish(),
});

export type ZoteroExportInput = z.infer<typeof ZoteroExportInputSchema>;

export class ZoteroExportTool extends defineTool({
  name: 'zotero_export',
  description:
    'Export BibTeX/BibLaTeX entries from Zotero by citation keys. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroExportInputSchema,
}) {
  protected async execute({ citekeys, format, library }: ZoteroExportInput) {
    const port = getZoteroPort();
    const translator = format || 'biblatex';

    const params: unknown[] = [citekeys, translator];
    if (library) {
      params.push(library);
    }

    const result = await callBetterBibTeX<string>(
      'item.export',
      params,
      port,
      ZOTERO_EXPORT_TIMEOUT_MS,
    );

    if (typeof result !== 'string' || result.trim() === '') {
      throw new ToolError(
        `No entries found for citation keys: ${citekeys.join(', ')}`,
      );
    }

    return {
      summary: `Exported ${citekeys.length} ${pluralize(citekeys.length, 'entry', 'entries')} as ${translator}`,
      output: result.trim(),
    };
  }
}
