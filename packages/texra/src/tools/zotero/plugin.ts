/**
 * The Zotero plugin: its library tools over Better BibTeX, the localhost
 * probe of its availability check, its icons and its card.
 */

// Third-party imports
import { Duration, Effect, type Cause } from 'effect';

// Local imports
import { scopedClient, Settings } from '@texra-ai/harness/plugins';
import type { TexraPlugin } from '@texra/tools/registry';
import { zoteroUrl } from './bbtClient';
import { ZoteroAddTool } from './ZoteroAddTool';
import { ZoteroCollectionsTool } from './ZoteroCollectionsTool';
import { ZoteroExportTool } from './ZoteroExportTool';
import { ZoteroSearchTool } from './ZoteroSearchTool';
import type { HttpClient, HttpClientError } from 'effect/http';
import { ZOTERO_PORT_SETTING } from '@texra/shared/settingsView/texraSettings';

const PROBE_TIMEOUT_MS = 2000;

/** The HTTP status a localhost endpoint answers with. */
const probeLocalhost: (
  url: string,
) => Effect.Effect<
  number,
  HttpClientError.HttpClientError | Cause.TimeoutError,
  HttpClient.HttpClient
> = Effect.fn('probeLocalhost')(
  function* (url: string) {
    const client = yield* scopedClient;
    return (yield* client.get(url)).status;
  },
  Effect.scoped,
  Effect.timeout(Duration.millis(PROBE_TIMEOUT_MS)),
);

/**
 * A probe that could not reach its endpoint answers "not running"; the
 * failure's tag is logged so a transport fault stays distinguishable from an
 * absent Zotero.
 */
function probeUnreachable(
  error: HttpClientError.HttpClientError | Cause.TimeoutError,
): Effect.Effect<boolean> {
  return Effect.logDebug('Zotero probe unreachable', {
    reason: error._tag === 'HttpClientError' ? error.reason._tag : error._tag,
  }).pipe(Effect.as(false));
}

export const zotero: TexraPlugin = {
  id: 'zotero',
  tools: [
    ZoteroCollectionsTool,
    ZoteroSearchTool,
    ZoteroAddTool,
    ZoteroExportTool,
  ],
  icons: {
    zotero_collections: 'book',
    zotero_search: 'book',
    zotero_add: 'book',
    zotero_export: 'book',
  },
  toggle: 'off',
  availability: {
    check: Effect.fn('zotero.availability')(function* ({ config }) {
      const port = Settings.getConfig(config, ZOTERO_PORT_SETTING);
      // The connector endpoint responds while Zotero runs; the Better
      // BibTeX JSON-RPC endpoint, while that plugin is installed.
      const bbt = yield* probeLocalhost(
        zoteroUrl(port, '/better-bibtex/json-rpc'),
      ).pipe(
        Effect.map(
          (status) => (status >= 200 && status < 300) || status === 405,
        ),
        Effect.catch(probeUnreachable),
      );
      const connectorUp = yield* probeLocalhost(
        zoteroUrl(port, '/connector/ping'),
      ).pipe(Effect.as(true), Effect.catch(probeUnreachable));
      let statusDetail = `Zotero not detected on port ${port}. Make sure Zotero is running.`;
      if (connectorUp)
        statusDetail = bbt
          ? `Zotero running on port ${port}, Better BibTeX responding.`
          : `Zotero detected on port ${port}, but Better BibTeX is not responding. Install the Better BibTeX plugin.`;
      return { available: bbt, statusDetail };
    }),
  },
  card: {
    name: 'Zotero Integration',
    description:
      'Search, add items to, and export citations from your Zotero library. Requires Better BibTeX plugin.',
    setup: {
      installGuide:
        'Requires Zotero with the Better BibTeX plugin installed.\n\n' +
        'Setup:\n' +
        '  1. Install Zotero (zotero.org)\n' +
        '  2. Install Better BibTeX plugin:\n' +
        '     - Download from retorque.re/zotero-better-bibtex\n' +
        '     - In Zotero: Tools > Add-ons > Install from File\n' +
        '  3. Keep Zotero running while using TeXRA\n\n' +
        'Better BibTeX exposes a JSON-RPC API on localhost:23119\n' +
        'that TeXRA uses to communicate with your library.',
      installUrl: 'https://retorque.re/zotero-better-bibtex/installation/',
      configNotes:
        'Zotero must be running with Better BibTeX installed. Port configurable via texra.bib.zoteroPort.',
    },
  },
};
