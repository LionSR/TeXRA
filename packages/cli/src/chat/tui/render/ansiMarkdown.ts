// CLI host's ANSI markdown adapter — builds on the shared `@shared/markdown`
// factory but swaps `MarkdownIt`'s HTML renderer rules for ANSI-emitting ones.
//
// Math is intentionally disabled in the CLI: terminals can't render KaTeX
// HTML, and a text-mode math engine would only obscure the source. `$…$`
// blocks fall through as plain markdown text (dim).
//
// The fence highlighter delegates to `cli-highlight`, which uses the same
// `highlight.js` grammars the webview already pulls — keeping fence rendering
// consistent between hosts without dragging the HTML wrapper through.

import Table from 'cli-table3';
import { highlight, supportsLanguage } from 'cli-highlight';
import { LRUCache } from 'lru-cache';
import MarkdownIt, { type RendererRule, type Token } from 'markdown-it';
import pico from 'picocolors';

import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import {
  createMarkdownProcessor,
  type MarkdownProcessorRenderEnv,
  type MarkdownProcessor,
} from '@shared/markdown/createMarkdownProcessor';
import {
  createMarkdownRenderer,
  type MarkdownItInstance,
} from '@shared/markdown/createMarkdownRenderer';
import { normalizeKnownHtmlForCliMarkdown } from './htmlMarkdownNormalize';
import { textDisplayWidth } from './terminalText';

/** SGR open/close codes wrapped through String.fromCharCode so the ESC byte
 *  is never a literal in source (pre-commit hooks have been known to mangle
 *  raw control chars). */
const ESC = String.fromCharCode(27);
const sgr = (code: number): string => `${ESC}[${code}m`;

interface AnsiMarkdownStyle {
  readonly enabled: boolean;
  bold(text: string): string;
  cyan(text: string): string;
  dim(text: string): string;
  gray(text: string): string;
  underline(text: string): string;
  sgr(code: number): string;
}

// One color gate for the whole package: picocolors' `createColors(false)` hands
// back identity functions, so there's no need to keep parallel on/off style
// objects (same pattern as `runtime/style.ts`'s `createCliStyle`). Raw SGR codes
// (strong/em/strikethrough/link) can't be neutered by `createColors`, so `sgr`
// stays explicitly gated.
function ansiMarkdownStyle(colorEnabled: boolean): AnsiMarkdownStyle {
  const c = pico.createColors(colorEnabled);
  return {
    enabled: colorEnabled,
    bold: c.bold,
    cyan: c.cyan,
    dim: c.dim,
    gray: c.gray,
    underline: c.underline,
    sgr: colorEnabled ? sgr : () => '',
  };
}

function highlightForTui(
  code: string,
  lang: string,
  style: AnsiMarkdownStyle,
): string {
  const trimmed = code.replace(/\n+$/, '');
  if (!style.enabled) return trimmed;
  if (lang && supportsLanguage(lang)) {
    try {
      return highlight(trimmed, { language: lang, ignoreIllegals: true });
    } catch {
      // fall through to plain rendering
    }
  }
  return style.gray(trimmed);
}

type ColumnAlign = 'left' | 'center' | 'right';

// markdown-it encodes GFM cell alignment as an inline `text-align` style on the
// `th`/`td` open token; map it to cli-table3's `colAligns` vocabulary.
function columnAlign(style: string | null): ColumnAlign {
  if (style?.includes('right')) return 'right';
  if (style?.includes('center')) return 'center';
  return 'left';
}

const TABLE_MIN_COL_WIDTH = 5;
// Fallback table width when the caller renders without a known terminal width
// (the live region and Markdown component both pass one, so this is rare).
const TABLE_FALLBACK_WIDTH = 80;

// cli-table3 pads every cell with one space on each side, so a column's total
// width is its content width + 2.
const TABLE_CELL_PADDING = 2;

// Size each column to its widest cell (display width, ANSI-aware) so a compact
// table stays compact instead of being stretched to fill the terminal. Only
// when the content-sized layout would overflow `width` do we fall back to an
// even split — capping the total so the trailing `wrapAnsiToWidth` hard-wrap
// can't shred the box-drawing borders. cli-table3's total width is the sum of
// the column widths plus one border column per boundary (numCols + 1). Returns
// undefined when there isn't room to cap, letting cli-table3 size to content.
function tableColWidths(
  head: readonly string[],
  rows: readonly (readonly string[])[],
  numCols: number,
  width: number | undefined,
): number[] | undefined {
  const total = Math.floor(width ?? TABLE_FALLBACK_WIDTH);
  const usable = total - (numCols + 1);
  if (usable < numCols * TABLE_MIN_COL_WIDTH) return undefined;

  // Natural width per column = widest cell content + padding (clamped to the
  // minimum). `textDisplayWidth` strips ANSI and counts wide glyphs as 2 cells.
  const natural = Array.from({ length: numCols }, (_, col) => {
    let widest = head[col] === undefined ? 0 : textDisplayWidth(head[col]);
    for (const row of rows) {
      const cell = row[col];
      if (cell !== undefined) widest = Math.max(widest, textDisplayWidth(cell));
    }
    return Math.max(TABLE_MIN_COL_WIDTH, widest + TABLE_CELL_PADDING);
  });

  // Content fits — keep the table compact (no full-width dead gaps).
  if (natural.reduce((sum, w) => sum + w, 0) <= usable) return natural;

  // Content overflows — distribute the usable width evenly and cap at `width`.
  const base = Math.floor(usable / numCols);
  const widths = Array.from({ length: numCols }, () => base);
  // Hand the floor remainder to the leftmost columns so the table fills `width`.
  let i = 0;
  for (let remainder = usable - base * numCols; remainder > 0; remainder--)
    widths[i++ % numCols] += 1;
  return widths;
}

// Lay out a parsed markdown table through cli-table3 (borders, per-cell word
// wrap, column widths) rather than hand-rolling alignment math.
function renderAnsiTable(
  head: readonly string[],
  rows: readonly (readonly string[])[],
  aligns: readonly ColumnAlign[],
  width: number | undefined,
  style: AnsiMarkdownStyle,
): string {
  const numCols = Math.max(head.length, ...rows.map((row) => row.length), 1);
  const table = new Table({
    head: head.map(style.bold),
    colWidths: tableColWidths(head, rows, numCols, width),
    colAligns: Array.from({ length: numCols }, (_, i) => aligns[i] ?? 'left'),
    wordWrap: true,
    // No cli-table3 colorizing — cell content already carries its own ANSI and
    // the border stays the terminal's default foreground.
    style: { head: [], border: [] },
  });
  for (const row of rows) table.push([...row]);
  return table.toString();
}

function restoreProtectedLatexInCell(cell: string, env: unknown): string {
  const restore = (env as MarkdownProcessorRenderEnv | undefined)
    ?.restoreProtectedLatex;
  return restore ? restore(cell) : cell;
}

function configureAnsi(
  md: MarkdownItInstance,
  width: number | undefined,
  style: AnsiMarkdownStyle,
): void {
  const r = md.renderer.rules;
  let quoteDepth = 0;
  let headingDepth = 0;
  let headingLevel = 0;
  let listDepth = 0;
  let linkHref: string | undefined;
  let linkText = '';

  const quotePrefix = (): string =>
    quoteDepth > 0 ? style.dim('│ '.repeat(quoteDepth)) : '';

  const startsAtQuoteOpen = (
    tokens: Parameters<RendererRule>[0],
    idx: number,
  ) => tokens[idx - 1]?.type === 'blockquote_open';

  const quoteBlockStart = (
    tokens: Parameters<RendererRule>[0],
    idx: number,
  ): string => {
    if (quoteDepth === 0 || startsAtQuoteOpen(tokens, idx)) return '';
    return quotePrefix();
  };

  const withQuoteGutter = (
    tokens: Parameters<RendererRule>[0],
    idx: number,
    body: string,
  ): string => {
    if (quoteDepth === 0) return body;
    return `${quoteBlockStart(tokens, idx)}${body.replaceAll(
      '\n',
      `\n${quotePrefix()}`,
    )}`;
  };

  // Styled sessions keep the tested no-visible-markers look (level is carried
  // by styling in `styleHeadingText`). Without color there is no styling left
  // at all — a heading would render as a plain paragraph — so the `#` markers
  // are re-emitted as the only structure cue a bare terminal can show.
  r.heading_open = (tokens, idx) => {
    headingDepth += 1;
    headingLevel = Number(tokens[idx]?.tag.slice(1)) || 1;
    const gutter = quoteDepth === 0 ? '\n' : quoteBlockStart(tokens, idx);
    return style.enabled ? gutter : `${gutter}${'#'.repeat(headingLevel)} `;
  };
  r.heading_close = () => {
    headingDepth = Math.max(0, headingDepth - 1);
    return '\n';
  };

  r.paragraph_open = (tokens, idx) => {
    if (quoteDepth === 0) return '';
    // markdown-it fires custom rules even for `hidden` paragraph tokens
    // (only the default `renderToken` short-circuits on hidden). Tight
    // lists inside blockquotes (`> - a\n> - b`) emit such hidden
    // paragraphs right after `list_item_open` — re-prefixing here would
    // inject the gutter after the bullet marker. The bullet rule already
    // sits inside the blockquote run, so the gutter is intact.
    if (tokens[idx]?.hidden) return '';
    const prev = tokens[idx - 1]?.type;
    if (prev === 'blockquote_open' || prev === 'list_item_open') return '';
    return quotePrefix();
  };
  r.paragraph_close = (tokens, idx) => {
    if (tokens[idx]?.hidden) return '\n';
    if (tokens[idx + 1]?.type === 'blockquote_close') return '\n';
    return quoteDepth > 0 ? `\n${quotePrefix()}\n` : '\n\n';
  };

  r.strong_open = () => style.sgr(1);
  r.strong_close = () => style.sgr(22);
  r.em_open = () => style.sgr(3);
  r.em_close = () => style.sgr(23);
  r.s_open = () => style.sgr(9);
  r.s_close = () => style.sgr(29);

  // One rank per level instead of a single uniform heading look: h1 adds an
  // underline, h2 keeps the classic bold cyan, h3+ steps down to plain bold —
  // otherwise `#` and `####` are visually the same heading.
  const styleHeadingText = (text: string): string => {
    if (headingDepth === 0) return text;
    if (headingLevel <= 1) return style.underline(style.bold(style.cyan(text)));
    if (headingLevel === 2) return style.bold(style.cyan(text));
    return style.bold(text);
  };

  r.code_inline = (tokens, idx) => {
    const code = `\`${tokens[idx]?.content ?? ''}\``;
    return headingDepth > 0 ? styleHeadingText(code) : style.cyan(code);
  };
  r.fence = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return '';
    const langName = token.info.trim().split(/\s+/)[0] ?? '';
    const body = md.options.highlight
      ? md.options.highlight(token.content, langName, '')
      : null;
    return `${withQuoteGutter(
      tokens,
      idx,
      body || style.gray(token.content.replace(/\n+$/, '')),
    )}\n\n`;
  };
  r.code_block = (tokens, idx) =>
    `${withQuoteGutter(
      tokens,
      idx,
      style.gray(tokens[idx]?.content.replace(/\n+$/, '') ?? ''),
    )}\n\n`;

  r.bullet_list_open = () => {
    listDepth += 1;
    return '';
  };
  r.bullet_list_close = () => {
    listDepth = Math.max(0, listDepth - 1);
    return '';
  };
  r.ordered_list_open = () => {
    listDepth += 1;
    return '';
  };
  r.ordered_list_close = () => {
    listDepth = Math.max(0, listDepth - 1);
    return '';
  };
  // The first item in a list inherits the blockquote gutter from
  // `blockquote_open`; continuation items follow a `list_item_close → \n`
  // and need the gutter re-injected so the second bullet doesn't render
  // at column 0. Indent scales with `listDepth` so nested items sit under
  // their parent instead of flattening to one level.
  r.list_item_open = (tokens, idx) => {
    const token = tokens[idx];
    const marker = token?.info ? `${token.info}${token.markup || '.'}` : '•';
    const prev = tokens[idx - 1]?.type;
    const fresh = prev === 'bullet_list_open' || prev === 'ordered_list_open';
    const indent = '  '.repeat(Math.max(1, listDepth));
    return `${fresh ? '' : quotePrefix()}${indent}${style.dim(marker)} `;
  };
  r.list_item_close = () => '';

  r.blockquote_open = (tokens, idx) => {
    quoteDepth += 1;
    return tokens[idx - 1]?.type === 'blockquote_open'
      ? style.dim('│ ')
      : quotePrefix();
  };
  r.blockquote_close = () => {
    quoteDepth = Math.max(0, quoteDepth - 1);
    return '\n';
  };

  r.hr = (tokens, idx) =>
    `${quoteBlockStart(tokens, idx)}${style.dim(
      '─'.repeat(Math.max(1, Math.min(40, width ?? 40))),
    )}\n`;

  // Emit raw SGR codes so the styling stays open across the link body. The
  // bracket characters are part of the styled run; if we used `pico.blue('[')`
  // here the close-code would land immediately and the link text would render
  // unstyled (Cursor finding). Bright blue (94), not blue (34): non-bright
  // ANSI blue is near-unreadable on stock dark palettes (~2.3:1 on xterm
  // black). The destination is appended after the link text — the terminal
  // has no other way to hand the URL to the reader — except when the text
  // already is the URL (autolinks).
  r.link_open = (tokens, idx) => {
    const token = tokens[idx];
    // Autolinks and linkified bare domains already show their destination as
    // the link text; only explicit `[text](url)` needs the url appended.
    const auto = token?.markup === 'linkify' || token?.info === 'auto';
    const href = token?.attrGet('href');
    linkHref = auto || href == null ? undefined : String(href);
    linkText = '';
    return `${style.sgr(4)}${style.sgr(94)}[`;
  };
  r.link_close = () => {
    const href = linkHref;
    linkHref = undefined;
    const suffix =
      href && href !== linkText ? ` ${style.dim(`(${href})`)}` : '';
    return `]${style.sgr(39)}${style.sgr(24)}${suffix}`;
  };

  r.softbreak = () => `\n${quotePrefix()}`;
  r.hardbreak = () => `\n${quotePrefix()}`;

  // markdown-it default `text` rule escapes HTML; we want raw text.
  r.text = (tokens, idx) => {
    const content = tokens[idx]?.content ?? '';
    if (linkHref !== undefined) linkText += content;
    return styleHeadingText(content);
  };
  r.image = (tokens, idx) =>
    style.dim(`[image: ${tokens[idx]?.content ?? ''}]`);

  // The table-family tokens (table_open … table_close) have no ANSI rules, so
  // we collapse each table's token range into a single pre-rendered
  // `ansi_table` token before the default render loop runs — otherwise the
  // in-cell `inline` tokens would stream into the output and the table tags
  // would fall through to markdown-it's default HTML renderer.
  r.ansi_table = (tokens, idx) => `${tokens[idx]?.content ?? ''}\n\n`;

  // The submodule's renderer typings narrow tokens to `unknown[]` and omit
  // `renderInline`; recover the real shapes locally.
  const renderInline = (
    md.renderer as unknown as {
      renderInline(tokens: Token[], options: unknown, env: unknown): string;
    }
  ).renderInline.bind(md.renderer);
  const render = md.renderer.render.bind(md.renderer);
  md.renderer.render = (rawTokens, options, env) => {
    quoteDepth = 0;
    headingDepth = 0;
    listDepth = 0;
    linkHref = undefined;
    const tokens = rawTokens as Token[];
    const collapsed: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]?.type !== 'table_open') {
        collapsed.push(tokens[i]!);
        continue;
      }
      const head: string[] = [];
      const rows: string[][] = [];
      const aligns: ColumnAlign[] = [];
      let cells: string[] = [];
      let inHeader = false;
      let col = 0;
      let j = i + 1;
      for (; j < tokens.length && tokens[j]?.type !== 'table_close'; j++) {
        const token = tokens[j]!;
        switch (token.type) {
          case 'thead_open':
            inHeader = true;
            break;
          case 'thead_close':
            inHeader = false;
            break;
          case 'tr_open':
            cells = [];
            col = 0;
            break;
          case 'tr_close':
            if (inHeader) head.push(...cells);
            else rows.push(cells);
            break;
          case 'th_open':
          case 'td_open': {
            const alignAttr = token.attrGet('style');
            if (inHeader)
              aligns[col] = columnAlign(
                typeof alignAttr === 'string' ? alignAttr : null,
              );
            col++;
            break;
          }
          case 'inline':
            cells.push(
              restoreProtectedLatexInCell(
                renderInline(token.children ?? [], options, env),
                env,
              ),
            );
            break;
        }
      }
      const tableToken = new MarkdownIt.Token('ansi_table', '', 0);
      tableToken.content = renderAnsiTable(head, rows, aligns, width, style);
      collapsed.push(tableToken);
      i = j; // land on table_close; the loop's i++ skips it
    }
    try {
      return render(collapsed, options, env);
    } finally {
      quoteDepth = 0;
      headingDepth = 0;
      listDepth = 0;
      linkHref = undefined;
    }
  };
}

// Table layout needs the terminal width baked into the renderer (the shared
// processor caches by content only), so each processor is bound to one
// (width, colorEnabled) pair. Keep a small LRU of processors rather than a
// single slot: callers are not guaranteed to agree on the pair (the row
// estimator defaults color on while a NO_COLOR painter passes false), and
// with a single slot any alternation would rebuild the processor and discard
// its content LRU — re-parsing every visible markdown body per frame.
const processorCache = new LRUCache<string, MarkdownProcessor>({ max: 4 });

function processorFor(
  width: number | undefined,
  colorEnabled: boolean,
): MarkdownProcessor {
  const key = `${width ?? 'auto'}:${colorEnabled ? 'color' : 'plain'}`;
  const cached = processorCache.get(key);
  if (cached) return cached;

  const style = ansiMarkdownStyle(colorEnabled);
  const renderer = createMarkdownRenderer({
    highlight: (code, lang) => highlightForTui(code, lang, style),
    configure: (md) => configureAnsi(md, width, style),
  });
  const processor = createMarkdownProcessor({
    renderer,
    // The CLI shows LaTeX refs as dim-underlined source (math rendering is
    // disabled), e.g. `\ref{sec:x}`.
    formatLatexReference: (refType, label) =>
      style.dim(style.underline(`\\${refType}{${label}}`)),
    // The CLI shows LaTeX source verbatim (math rendering is disabled), so
    // shield `$…$` / `$$…$$` / `\(…\)` / `\[…\]` spans from markdown-it, which
    // would otherwise strip `\(`→`(`, `\;`→`;` and eat `_{…}` subscripts.
    protectLatexMath: true,
  });
  processorCache.set(key, processor);
  return processor;
}

interface RenderAnsiMarkdownOptions {
  readonly width?: number;
  readonly colorEnabled?: boolean;
}

/**
 * Render markdown to an ANSI-coloured string suitable for an Ink `<Text>`.
 * Uses a per-host LRU cache so streaming deltas don't re-render the entire
 * message body each frame.
 */
export function renderAnsiMarkdown(
  content: string,
  options: RenderAnsiMarkdownOptions = {},
): string {
  const processor = processorFor(options.width, options.colorEnabled ?? true);
  return wrapAnsiToWidth(
    processor(normalizeKnownHtmlForCliMarkdown(content)),
    options.width,
    true,
  ).trimEnd();
}

/** Test seam: drop the cached processors so tests can re-init cleanly. */
export function _resetAnsiMarkdownForTests(): void {
  processorCache.clear();
}

/** Test seam: returns cache hit/miss counters across cached processors. */
export function _ansiMarkdownStatsForTests(): {
  hits: number;
  misses: number;
} {
  let hits = 0;
  let misses = 0;
  for (const processor of processorCache.values()) {
    hits += processor.stats.hits();
    misses += processor.stats.misses();
  }
  return { hits, misses };
}
