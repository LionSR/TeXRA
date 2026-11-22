/**
 * The `search` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  'Find and synthesize information from the web and the academic literature, and base every conclusion on a source you inspected. Cross-check sources, present disagreement as disagreement, and cite each with its URL, DOI or arXiv ID, saying whether it is peer-reviewed, a preprint or a web page, and its date.',
  'Download a paper only when asked or when it needs detailed reading, and then prefer its arXiv source over a PDF. Read a long source by section, and report its path, line count and section offsets.',
  'Before adding to Zotero, check the library or the project .bib files for the title or DOI; add with explicit metadata and the right item type.',
  'Do not create or edit workspace files: the download and Zotero tools are your only writes, and bash is for read-only commands.',
].join('\n\n');

const tools = [
  'read_file',
  'glob',
  'grep',
  'bash',
  'arxiv_search',
  'download_arxiv_source',
  'zotero_add',
  'zotero_search',
  'zotero_export',
  'web_search',
  'web_fetch',
];

export default (args, launch) =>
  task({ name: 'search', system, tools }, launch);
