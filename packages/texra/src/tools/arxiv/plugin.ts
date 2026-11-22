/** The arXiv plugin: paper search and source download, its icons and its
 *  card. */

// Third-party imports
import { Layer } from 'effect';
import * as RateLimiter from 'effect/persistence/RateLimiter';

// Local imports
import { definePlugin } from '@texra-ai/worldline/plugins';
import type { TexraPlugin } from '@texra/tools/registry';
import { texraPlugin } from '@texra/tools/texraPlugin';
import { ArxivDownloadTool } from './ArxivDownloadTool';
import { ArxivSearchTool } from './ArxivSearchTool';

export const arxiv: TexraPlugin = texraPlugin({
  ...definePlugin<RateLimiter.RateLimiter>({
    id: 'arxiv',
    tools: [ArxivSearchTool, ArxivDownloadTool],
    prompt: ({ offered }) =>
      offered.includes('download_arxiv_source')
        ? "Use `download_arxiv_source` to work with a paper's own equations and source instead of a summary of it."
        : '',
    // The API's rate limit is shared by every search in the process.
    processLayer: {
      layer: RateLimiter.layer.pipe(
        Layer.provide(RateLimiter.layerStoreMemory),
      ),
    },
  }),
  icons: { arxiv_search: 'book', download_arxiv_source: 'cloud-arrow-down' },
  dashboard: {
    name: 'ArXiv Search & Download',
    description: 'Search arXiv papers and download LaTeX source packages.',
  },
});
