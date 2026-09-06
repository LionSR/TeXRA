/**
 * Export BibTeX entries from Zotero via Better BibTeX JSON-RPC API.
 *
 * Requires the Better BibTeX plugin to be installed in Zotero.
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 */

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports - core
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { effectRuntime } from '@platform/processRuntime';
import { ToolError, type ToolResult } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { pluralize } from '@utils/text/stringUtils';

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

type ZoteroExportInput = z.infer<typeof ZoteroExportInputSchema>;

const exportEntries = Effect.fn('ZoteroExportTool.execute')(function* ({
  citekeys,
  format,
  library,
}: ZoteroExportInput) {
  const port = getZoteroPort();
  const translator = format || 'biblatex';

  const params: unknown[] = [citekeys, translator];
  if (library) {
    params.push(library);
  }

  const result = yield* callBetterBibTeX(
    'item.export',
    params,
    port,
    z.string(),
    ZOTERO_EXPORT_TIMEOUT_MS,
  );

  const exported = result.trim();
  if (exported === '') {
    return yield* Effect.fail(
      new ToolError(
        `No entries found for citation keys: ${citekeys.join(', ')}`,
      ),
    );
  }

  return executed(
    exported,
    `Exported ${citekeys.length} ${pluralize(citekeys.length, 'entry')} as ${translator}`,
  );
});

export class ZoteroExportTool extends defineTool({
  name: 'zotero_export',
  description:
    'Export BibTeX/BibLaTeX entries from Zotero by citation keys. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroExportInputSchema,
}) {
  protected execute(input: ZoteroExportInput): Promise<ToolResult> {
    return effectRuntime().runPromise(exportEntries(input), {
      signal: getCurrentToolCallContext()?.signal,
    });
  }
}
