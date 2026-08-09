// Configurable markdown-it factory shared by the webview (HTML output) and
// the CLI TUI (ANSI output).
//
// The factory takes a highlight hook and an optional `configure` hook. Math
// is wired by the caller through a `usePlugin` callback (see
// `createTexmathPlugin`) so non-math hosts — the CLI TUI in particular —
// don't pull `markdown-it-texmath` into their bundle.

import MarkdownIt from 'markdown-it';

/** Instance type for the markdown-it renderer (`new MarkdownIt(...)`). */
export type MarkdownItInstance = InstanceType<typeof MarkdownIt>;

interface MarkdownRendererConfig {
  /**
   * Code-fence highlighter — same shape as markdown-it's `highlight` option.
   * The webview returns HTML; the CLI host returns an ANSI-coloured string.
   */
  readonly highlight: (code: string, lang: string) => string;
  /**
   * Caller-supplied plugin hook — runs once after `new MarkdownIt(...)`. The
   * webview uses this to wire `markdown-it-texmath`; the CLI host omits it so
   * the texmath dependency stays out of the CLI bundle.
   */
  readonly usePlugin?: (md: MarkdownItInstance) => MarkdownItInstance;
  /**
   * Hook to mutate the constructed `MarkdownIt` instance — typically used to
   * swap `md.renderer.rules.*` to emit ANSI instead of HTML.
   */
  readonly configure?: (md: MarkdownItInstance) => void;
}

export function createMarkdownRenderer(
  config: MarkdownRendererConfig,
): MarkdownItInstance {
  let md = new MarkdownIt({
    breaks: false,
    linkify: true,
    html: false,
    highlight: config.highlight,
  });
  md.linkify.set({ fuzzyLink: true, urlAuth: true });
  if (config.usePlugin) md = config.usePlugin(md);
  config.configure?.(md);
  return md;
}
