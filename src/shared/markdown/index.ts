// `createTexmathPlugin` is intentionally NOT re-exported from this barrel —
// reaching it through `@shared/markdown` would pin the `markdown-it-texmath`
// side-effecting import into the module graph even for hosts that never call
// the plugin (esbuild can't tree-shake an unused re-export across a
// side-effect import). Math-enabled hosts import directly from
// `@shared/markdown/texmathPlugin` instead.

export {
  createMarkdownRenderer,
  type MarkdownItInstance,
  type MarkdownRendererConfig,
} from './createMarkdownRenderer';
export {
  createMarkdownProcessor,
  type LatexReferenceFormatter,
  type MarkdownProcessor,
  type MarkdownProcessorConfig,
} from './createMarkdownProcessor';
