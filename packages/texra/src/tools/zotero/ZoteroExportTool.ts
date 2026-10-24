/**
 * Export BibTeX entries from Zotero via Better BibTeX JSON-RPC API.
 *
 * Requires the Better BibTeX plugin to be installed in Zotero.
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 */

// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports - core
import { defineTool } from '@texra-ai/harness';
import { executed, ToolError } from '@texra-ai/harness/plugins';
import { pluralize } from '@texra-ai/harness/transcript';

// Local imports - zotero
import { callBetterBibTeX, withZoteroPort } from './bbtClient';

const ZOTERO_EXPORT_TIMEOUT_MS = 30_000; // 30 s

const ZoteroExportInputSchema = Schema.Struct({
  citekeys: Schema.Array(Schema.String.check(Schema.isMinLength(1)))
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(50))
    .annotate({
      description: 'List of Better BibTeX citation keys to export.',
    }),
  format: Schema.optional(
    Schema.NullOr(
      Schema.Literals(['bibtex', 'biblatex', 'json']).annotate({
        description: 'Export format. Defaults to biblatex.',
      }),
    ),
  ),
  library: Schema.optional(
    Schema.NullOr(
      Schema.String.annotate({
        description:
          'Optional library ID. Omit to search in My Library, or use "*" for all.',
      }),
    ),
  ),
});

type ZoteroExportInput = typeof ZoteroExportInputSchema.Type;

const exportEntries = Effect.fn('ZoteroExportTool.execute')(function* (
  { citekeys, format, library }: ZoteroExportInput,
  port: number,
) {
  const translator = format || 'biblatex';

  const params: unknown[] = library
    ? [citekeys, translator, library]
    : [citekeys, translator];

  const result = yield* callBetterBibTeX(
    'item.export',
    params,
    port,
    Schema.String,
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

export const ZoteroExportTool = defineTool({
  name: 'zotero_export',
  replay: 'safe',
  description:
    'Export BibTeX/BibLaTeX entries from Zotero by citation keys. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroExportInputSchema,
  execute: withZoteroPort(exportEntries),
});
