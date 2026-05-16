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
import type { RenderRule } from 'markdown-it/lib/renderer.mjs';
import pico from 'picocolors';

import {
  createMarkdownProcessor,
  createMarkdownRenderer,
  type MarkdownItInstance,
  type MarkdownProcessor,
} from '@shared/markdown';

type MdInstance = MarkdownItInstance;
type Rule = RenderRule;
type Tokens = Parameters<Rule>[0];
function rule(impl: (tokens: Tokens, idx: number) => string): Rule {
  return impl as Rule;
}

/** SGR open/close codes wrapped through String.fromCharCode so the ESC byte
 *  is never a literal in source (pre-commit hooks have been known to mangle
 *  raw control chars). */
const ESC = String.fromCharCode(27);
const sgr = (code: number): string => `${ESC}[${code}m`;

/** Sentinel that wraps pre-coloured fence output so the fence rule can pass
 *  it through without HTML-style wrapping. NUL bytes (0x00) keep it out of
 *  any realistic markdown source. */
const NUL = String.fromCharCode(0);
const ANSI_FENCE_OPEN = `${NUL}${NUL}ANSI_FENCE_OPEN${NUL}${NUL}`;
const ANSI_FENCE_CLOSE = `${NUL}${NUL}ANSI_FENCE_CLOSE${NUL}${NUL}`;

function highlightForTui(code: string, lang: string): string {
  const trimmed = code.replace(/\n+$/, '');
  if (lang && supportsLanguage(lang)) {
    try {
      const coloured = highlight(trimmed, {
        language: lang,
        ignoreIllegals: true,
      });
      return `${ANSI_FENCE_OPEN}${coloured}${ANSI_FENCE_CLOSE}`;
    } catch {
      // fall through to plain rendering
    }
  }
  return `${ANSI_FENCE_OPEN}${pico.gray(trimmed)}${ANSI_FENCE_CLOSE}`;
}

function stripFenceMarkers(raw: string): string {
  return raw.replaceAll(ANSI_FENCE_OPEN, '').replaceAll(ANSI_FENCE_CLOSE, '');
}

function configureAnsi(md: MdInstance): void {
  const r = md.renderer.rules;

  const headingOpen = rule((tokens, idx) => {
    const level = Number(tokens[idx]?.tag?.slice(1) ?? 1);
    const marker = '#'.repeat(level);
    return `\n${pico.bold(pico.cyan(`${marker} `))}`;
  });
  const codeInline = rule((tokens, idx) =>
    pico.cyan(`\`${tokens[idx]?.content ?? ''}\``),
  );
  const fence = rule((tokens, idx) => {
    const token = tokens[idx];
    if (!token) return '';
    const langName = token.info.trim().split(/\s+/)[0] ?? '';
    const raw = md.options.highlight
      ? md.options.highlight(token.content, langName, '')
      : '';
    const body =
      typeof raw === 'string' && raw.length > 0
        ? raw
        : `${ANSI_FENCE_OPEN}${pico.gray(token.content.replace(/\n+$/, ''))}${ANSI_FENCE_CLOSE}`;
    return `${stripFenceMarkers(body)}\n\n`;
  });
  const codeBlock = rule(
    (tokens, idx) =>
      `${pico.gray(tokens[idx]?.content.replace(/\n+$/, '') ?? '')}\n\n`,
  );
  const listItemOpen = rule((tokens, idx) => {
    const marker = tokens[idx]?.info ? `${tokens[idx]?.info}.` : '•';
    return `  ${pico.dim(marker)} `;
  });
  const textRule = rule((tokens, idx) => tokens[idx]?.content ?? '');
  const image = rule((tokens, idx) => {
    const alt = tokens[idx]?.content ?? '';
    return pico.dim(`[image: ${alt}]`);
  });

  r.heading_open = headingOpen;
  r.heading_close = () => '\n';

  r.paragraph_open = () => '';
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

  r.blockquote_open = () => pico.dim('│ ');
  r.blockquote_close = () => '\n';

  r.hr = () => `${pico.dim('─'.repeat(40))}\n`;

  // Emit raw SGR codes so the styling stays open across the link body. The
  // bracket characters are part of the styled run; if we used `pico.blue('[')`
  // here the close-code would land immediately and the link text would render
  // unstyled (Cursor finding).
  r.link_open = () => `${sgr(4)}${sgr(34)}[`;
  r.link_close = () => `]${sgr(39)}${sgr(24)}`;

  r.softbreak = () => '\n';
  r.hardbreak = () => '\n';

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
