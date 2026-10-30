/** The Zotero plugin: its library tools over Better BibTeX, and its card. */

// Local imports
import { ZOTERO_AVAILABILITY } from '@texra/tools/pluginAvailability';
import type { TexraPlugin } from '@texra/tools/registry';
import { ZoteroAddTool } from './ZoteroAddTool';
import { ZoteroCollectionsTool } from './ZoteroCollectionsTool';
import { ZoteroExportTool } from './ZoteroExportTool';
import { ZoteroSearchTool } from './ZoteroSearchTool';

export const zotero: TexraPlugin = {
  id: 'zotero',
  tools: [
    ZoteroCollectionsTool,
    ZoteroSearchTool,
    ZoteroAddTool,
    ZoteroExportTool,
  ],
  toggle: 'off',
  availability: ZOTERO_AVAILABILITY,
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
