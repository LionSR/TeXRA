/** The arXiv plugin: paper search and source download, its icons and its
 *  card. */

// Local imports
import type { TexraPlugin } from '@texra/tools/registry';
import { ArxivDownloadTool } from './ArxivDownloadTool';
import { ArxivSearchTool } from './ArxivSearchTool';

export const arxiv: TexraPlugin = {
  id: 'arxiv',
  tools: [ArxivSearchTool, ArxivDownloadTool],
  icons: { arxiv_search: 'book', download_arxiv_source: 'cloud-arrow-down' },
  card: {
    name: 'ArXiv Search & Download',
    description: 'Search arXiv papers and download LaTeX source packages.',
  },
};
