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

import { highlight, supportsLanguage } from 'cli-highlight';
import pico from 'picocolors';

import {
  createMarkdownProcessor,
  createMarkdownRenderer,
  type MarkdownItInstance,
  type MarkdownProcessor,
} from '@shared/markdown';

import type { RenderRule } from 'markdown-it/lib/renderer.mjs';

/** SGR open/close codes wrapped through String.fromCharCode so the ESC byte
 *  is never a literal in source (pre-commit hooks have been known to mangle
 *  raw control chars). */
const ESC = String.fromCharCode(27);
const sgr = (code: number): string => `${ESC}[${code}m`;

function highlightForTui(code: string, lang: string): string {
  const trimmed = code.replace(/\n+$/, '');
  if (lang && supportsLanguage(lang)) {
    try {
      return highlight(trimmed, { language: lang, ignoreIllegals: true });
    } catch {
      // fall through to plain rendering
    }
  }
  return pico.gray(trimmed);
}

function configureAnsi(md: MarkdownItInstance): void {
  const r = md.renderer.rules;
  let quoteDepth = 0;

  const quotePrefix = (): string =>
    quoteDepth > 0 ? pico.dim('│ '.repeat(quoteDepth)) : '';

  const headingOpen: RenderRule = (tokens, idx) => {
    const level = Number(tokens[idx]?.tag?.slice(1) ?? 1);
    const marker = '#'.repeat(level);
    return `\n${pico.bold(pico.cyan(`${marker} `))}`;
  };
  const codeInline: RenderRule = (tokens, idx) =>
    pico.cyan(`\`${tokens[idx]?.content ?? ''}\``);
  const fence: RenderRule = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return '';
    const langName = token.info.trim().split(/\s+/)[0] ?? '';
    const body = md.options.highlight
      ? md.options.highlight(token.content, langName, '')
      : null;
    return `${body || pico.gray(token.content.replace(/\n+$/, ''))}\n\n`;
  };
  const codeBlock: RenderRule = (tokens, idx) =>
    `${pico.gray(tokens[idx]?.content.replace(/\n+$/, '') ?? '')}\n\n`;
  const listItemOpen: RenderRule = (tokens, idx) => {
    const token = tokens[idx];
    const marker = token?.info ? `${token.info}${token.markup || '.'}` : '•';
    // The first item in a list inherits the blockquote gutter from
    // `blockquote_open`; continuation items follow a `list_item_close → \n`
    // and need the gutter re-injected so the second bullet doesn't render
    // at column 0.
    const prev = tokens[idx - 1]?.type;
    const fresh = prev === 'bullet_list_open' || prev === 'ordered_list_open';
    return `${fresh ? '' : quotePrefix()}  ${pico.dim(marker)} `;
  };
  const paragraphOpen: RenderRule = (tokens, idx) => {
    if (quoteDepth === 0) return '';
    const token = tokens[idx];
    // markdown-it fires custom rules even for `hidden` paragraph tokens
    // (only the default `renderToken` short-circuits on hidden). Tight
    // lists inside blockquotes (`> - a\n> - b`) emit such hidden
    // paragraphs right after `list_item_open` — re-prefixing here would
    // inject the gutter after the bullet marker. The bullet rule already
    // sits inside the blockquote run, so the gutter is intact.
    if (token?.hidden) return '';
    const prev = tokens[idx - 1]?.type;
    if (prev === 'blockquote_open' || prev === 'list_item_open') return '';
    return quotePrefix();
  };
  const textRule: RenderRule = (tokens, idx) => tokens[idx]?.content ?? '';
  const image: RenderRule = (tokens, idx) => {
    const alt = tokens[idx]?.content ?? '';
    return pico.dim(`[image: ${alt}]`);
  };

  r.heading_open = headingOpen;
  r.heading_close = () => '\n';

  r.paragraph_open = paragraphOpen;
  r.paragraph_close = () => '\n';

  r.strong_open = () => sgr(1);
  r.strong_close = () => sgr(22);
  r.em_open = () => sgr(3);
  r.em_close = () => sgr(23);
  r.s_open = () => sgr(9);
  r.s_close = () => sgr(29);

  r.code_inline = codeInline;
  r.fence = fence;
  r.code_block = codeBlock;

  r.bullet_list_open = () => '';
  r.bullet_list_close = () => '';
  r.ordered_list_open = () => '';
  r.ordered_list_close = () => '';
  r.list_item_open = listItemOpen;
  r.list_item_close = () => '';

  r.blockquote_open = (tokens, idx) => {
    quoteDepth += 1;
    return tokens[idx - 1]?.type === 'blockquote_open'
      ? pico.dim('│ ')
      : quotePrefix();
  };
  r.blockquote_close = () => {
    quoteDepth = Math.max(0, quoteDepth - 1);
    return '\n';
  };

  r.hr = () => `${pico.dim('─'.repeat(40))}\n`;

  // Emit raw SGR codes so the styling stays open across the link body. The
  // bracket characters are part of the styled run; if we used `pico.blue('[')`
  // here the close-code would land immediately and the link text would render
  // unstyled (Cursor finding).
  r.link_open = () => `${sgr(4)}${sgr(34)}[`;
  r.link_close = () => `]${sgr(39)}${sgr(24)}`;

  r.softbreak = () => `\n${quotePrefix()}`;
  r.hardbreak = () => `\n${quotePrefix()}`;

  // markdown-it default `text` rule escapes HTML; we want raw text.
  r.text = textRule;
  r.image = image;
}

function formatAnsiLatexReference(refType: string, label: string): string {
  return pico.dim(pico.underline(`\\${refType}{${label}}`));
}

let cachedProcessor: MarkdownProcessor | null = null;

/**
 * Render markdown to an ANSI-coloured string suitable for an Ink `<Text>`.
 * Uses a per-host LRU cache so streaming deltas don't re-render the entire
 * message body each frame.
 */
export function renderAnsiMarkdown(content: string): string {
  if (!cachedProcessor) {
    const renderer = createMarkdownRenderer({
      highlight: highlightForTui,
      configure: configureAnsi,
    });
    cachedProcessor = createMarkdownProcessor({
      renderer,
      formatLatexReference: formatAnsiLatexReference,
    });
  }
  return cachedProcessor(content).trimEnd();
}

/** Test seam: drop the cached processor so tests can re-init cleanly. */
export function _resetAnsiMarkdownForTests(): void {
  cachedProcessor = null;
}

/** Test seam: returns cache hit/miss counters for the active processor. */
export function _ansiMarkdownStatsForTests(): {
  hits: number;
  misses: number;
} {
  return {
    hits: cachedProcessor?.stats.hits() ?? 0,
    misses: cachedProcessor?.stats.misses() ?? 0,
  };
}
