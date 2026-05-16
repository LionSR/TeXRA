// Configurable markdown-it factory shared by the webview (HTML output) and
// the CLI TUI (ANSI output).
//
// The factory takes a highlight hook, an optional math-engine config, and an
// optional `configure` hook the caller uses to swap markdown-it's renderer
// rules. The webview ships HTML rules (the markdown-it default); the CLI
// host overrides them with ANSI emitters.

// `@types/markdown-it@14`'s entry-point `.d.mts` re-exports only `default` and
// a few helpers, dropping the `MarkdownIt` instance interface. Importing from
// the lib entry directly recovers the typed instance so consumers can access
// `.renderer`, `.options`, `.use(...)` without falling back to `any`.
import MarkdownIt from 'markdown-it/lib/index.mjs';
import texmath from 'markdown-it-texmath';

/** Instance type for the markdown-it renderer (`new MarkdownIt(...)`). */
export type MarkdownItInstance = InstanceType<typeof MarkdownIt>;

// `markdown-it-texmath` only defines `\[...\]` as a *block* rule out of the
// box; we want it inline too so the renderer is consistent across hosts.
// Register once at module load — markdown-it-texmath rules.brackets.inline is
// process-global, so duplicating from multiple factories would create dup
// rules.
let inlineRuleInstalled = false;
function installInlineDisplayRule(): void {
  if (inlineRuleInstalled) return;
  texmath.rules.brackets.inline.push({
    name: 'math_inline_display',
    rex: /\\\[([\s\S]+?)\\\]/gy,
    tmpl: '<section><eqn>$1</eqn></section>',
    tag: '\\[',
    displayMode: true,
  });
  inlineRuleInstalled = true;
}

export interface MathConfig {
  /** Math engine (e.g. `katex`) passed to `markdown-it-texmath`. */
  readonly engine: unknown;
  /**
   * Delimiters argument forwarded to texmath. Default matches the legacy
   * webview config so existing content keeps rendering identically.
   */
  readonly delimiters?: ReadonlyArray<string>;
  /** Engine-specific options (e.g. katex `{ throwOnError, macros, ... }`). */
  readonly engineOptions?: Record<string, unknown>;
}

export interface MarkdownRendererConfig {
  /**
   * Code-fence highlighter — same shape as markdown-it's `highlight` option.
   * The webview returns HTML; the CLI host returns an ANSI-coloured string
   * wrapped in a sentinel so the ANSI renderer rules can pass it through
   * unescaped.
   */
  readonly highlight: (code: string, lang: string) => string;
  /** Math engine + options; omit to disable texmath entirely. */
  readonly math?: MathConfig;
  /**
   * Hook to mutate the constructed `MarkdownIt` instance — typically used to
   * swap `md.renderer.rules.*` to emit ANSI instead of HTML.
   */
  readonly configure?: (md: MarkdownItInstance) => void;
}

export function createMarkdownRenderer(
  config: MarkdownRendererConfig,
): MarkdownItInstance {
  installInlineDisplayRule();
  let md = new MarkdownIt({
    breaks: false,
    linkify: true,
    html: false,
    highlight: config.highlight,
  });
  if (config.math) {
    // `markdown-it-texmath`'s exported function signature doesn't perfectly
    // match markdown-it@14's `PluginWithOptions<T>` overload — cast through
    // the plugin shape so the call typechecks without losing call-site safety.
    type TexmathPlugin = Parameters<MarkdownItInstance['use']>[0];
    md = md.use(texmath as unknown as TexmathPlugin, {
      engine: config.math.engine,
      delimiters: config.math.delimiters ?? ['dollars', 'brackets', 'beg_end'],
      katexOptions: config.math.engineOptions,
    });
  }
  config.configure?.(md);
  return md;
}
