// Configurable markdown-it factory shared by the webview (HTML output) and
// the CLI TUI (ANSI output).
//
// The factory takes a highlight hook and an optional `configure` hook. Math
// is wired by the caller through a `usePlugin` callback (see
// `markdownTexmathPlugin`) so non-math hosts — the CLI TUI in particular —
// don't pull `markdown-it-texmath` into their bundle.

// `@types/markdown-it@14`'s entry-point `.d.mts` re-exports only `default` and
// a few helpers, dropping the `MarkdownIt` instance interface. Importing from
// the lib entry directly recovers the typed instance so consumers can access
// `.renderer`, `.options`, `.use(...)` without falling back to `any`.
import MarkdownIt from 'markdown-it/lib/index.mjs';

/** Instance type for the markdown-it renderer (`new MarkdownIt(...)`). */
export type MarkdownItInstance = InstanceType<typeof MarkdownIt>;

export interface MarkdownRendererConfig {
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
  if (config.usePlugin) md = config.usePlugin(md);
  config.configure?.(md);
  return md;
}
