/** The arXiv plugin: paper search and source download, its icons and its
 *  card. */

// Third-party imports
import { Layer } from 'effect';
import * as RateLimiter from 'effect/persistence/RateLimiter';

// Local imports
import { definePlugin } from '@texra-ai/harness/plugins';
import type { TexraPlugin } from '@texra/tools/registry';
import { ArxivDownloadTool } from './ArxivDownloadTool';
import { ArxivSearchTool } from './ArxivSearchTool';

export const arxiv: TexraPlugin = {
  ...definePlugin<RateLimiter.RateLimiter>({
    id: 'arxiv',
    tools: [ArxivSearchTool, ArxivDownloadTool],
    // The API's rate limit is shared by every search in the process.
    processLayer: {
      layer: RateLimiter.layer.pipe(
        Layer.provide(RateLimiter.layerStoreMemory),
      ),
    },
  }),
  icons: { arxiv_search: 'book', download_arxiv_source: 'cloud-arrow-down' },
  card: {
    name: 'ArXiv Search & Download',
    description: 'Search arXiv papers and download LaTeX source packages.',
  },
};
