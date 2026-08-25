// Stroke icon language for the desktop app.
//
// The desktop renderer uses one Lucide stroke language throughout. This module
// registers both Web Awesome icon-library names with Lucide geometry, including
// a Lucide question marker for unknown runtime names.
//
// Names are the existing `TeXRAIconName` values, so no call site changes: every
// `waIcon('file-code')` in the shared components silently upgrades.

import {
  registerIconLibrary,
  type IconLibraryResolver,
} from '@awesome.me/webawesome/dist/components/icon/library.js';
import iconNodes from 'lucide-static/icon-nodes.json';

import type { TeXRAIconName } from '@shared/wa/iconNames';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

/**
 * Our icon name -> Lucide icon name.
 *
 * Only names that differ need an entry; identical names resolve directly.
 */
const LUCIDE_NAME_BY_TEXRA_NAME: Readonly<Record<string, string>> = {
  // Punctuation / chrome
  xmark: 'x',
  'circle-xmark': 'circle-x',
  'circle-exclamation': 'circle-alert',
  'circle-question': 'circle-question-mark',
  'circle-info': 'info',
  'circle-user': 'circle-user-round',
  'triangle-exclamation': 'triangle-alert',

  // Arrows / navigation
  'arrow-rotate-left': 'rotate-ccw',
  'arrows-rotate': 'refresh-cw',
  'rotate-right': 'rotate-cw',
  'arrow-up-right-from-square': 'external-link',
  'backward-step': 'skip-back',
  'forward-step': 'skip-forward',
  'caret-down': 'chevron-down',

  // Files / storage
  'file-lines': 'file-text',
  'file-pdf': 'file-text',
  'file-export': 'file-output',
  'floppy-disk': 'save',
  'box-archive': 'archive',
  box: 'package',
  'magnifying-glass': 'search',
  'cloud-arrow-down': 'cloud-download',
  'cloud-arrow-up': 'cloud-upload',

  // Tools / concepts
  gear: 'settings',
  'screwdriver-wrench': 'wrench',
  'wand-magic-sparkles': 'wand-sparkles',
  flask: 'flask-conical',
  microphone: 'mic',
  'paper-plane': 'send',
  'clock-rotate-left': 'clock-arrow-left',
  'code-branch': 'git-branch',
  'code-compare': 'git-compare',
  'check-double': 'check-check',
  'list-check': 'list-checks',
  bolt: 'zap',
  thumbtack: 'pin',
  'thumbtack-slash': 'pin-off',
  spinner: 'loader-circle',

  // Layout / window controls.
  'window-maximize': 'panel-bottom',
  compress: 'minimize-2',
  'picture-in-picture': 'panel-right',
  // Canonical names Lucide spells differently, found by auditing every
  // waIcon() call site against the Lucide set rather than by guessing.
  bullseye: 'target',
  'file-circle-plus': 'file-plus',
  robot: 'bot',
  'right-to-bracket': 'log-in',
  'right-from-bracket': 'log-out',
  'code-merge': 'git-merge',
  'magnifying-glass-chart': 'search-code',
  'note-sticky': 'sticky-note',
  'plus-minus': 'diff',
  meteor: 'sparkles',
  cube: 'box',
  'diagram-project': 'workflow',
  'list-ul': 'list',
  comments: 'messages-square',
  comment: 'message-circle',
  hashtag: 'hash',
} satisfies Partial<Record<TeXRAIconName, string>>;

/**
 * Lucide's icon geometry as data: `{ name: [[tag, attrs], ...] }`.
 *
 * Imported as one JSON module rather than globbing the per-icon .svg files —
 * Vite's root is src/renderer, so a `/node_modules/...` glob silently resolves
 * to nothing and every icon renders blank. A bare module specifier is resolved
 * by the bundler and fails loudly if missing.
 */
// Via `unknown`: the JSON's inferred type is a positional (string | attrs)[]
// union per node, which does not overlap the tuple shape we consume it as.
const LUCIDE_ICON_NODES = iconNodes as unknown as Record<
  string,
  ReadonlyArray<readonly [string, Record<string, string>]>
>;

/**
 * Builds an SVG for a Lucide icon.
 *
 * No fixed width/height so it scales with font-size, and stroke-width 1.75
 * rather than Lucide's default 2 so icons sit beside the UI type instead of
 * out-weighing it.
 */
function lucideSvg(name: string): string | undefined {
  const nodes = LUCIDE_ICON_NODES[name];
  if (!nodes) return undefined;
  const children = nodes
    .map(([tag, attrs]) => {
      const serialized = Object.entries(attrs)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
      // `fill="none"` has to sit on each shape, not on the <svg>. wa-icon's
      // shadow stylesheet declares `svg { fill: currentColor }`, and a CSS
      // declaration beats a presentation *attribute* on the same element — so a
      // root-level fill="none" is overridden and every stroke icon renders as a
      // filled blob. A fill attribute on the child shapes is not targeted by
      // that rule, so it survives.
      return `<${tag} ${serialized} fill="none"/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +
    `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ` +
    `stroke-linejoin="round">${children}</svg>`
  );
}

/**
 * Registration runs at module scope, on import, rather than through an exported
 * function. ES imports hoist above statements, so a `register()` call in the
 * renderer entry would execute only after every WA component module had already
 * been evaluated. A side-effect import placed after '@shared/wa' is the only
 * ordering that reliably wins.
 */

function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const missingIconUri = svgDataUri(
  // Lucide renamed this glyph across releases (circle-help -> circle-question-
  // mark), so the inline fallback is not decoration: it is what keeps an
  // unknown-icon marker visible after a package bump moves the name again.
  lucideSvg('circle-question-mark') ??
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" fill="none"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4" fill="none"/><circle cx="12" cy="17" r="1" fill="currentColor"/></svg>',
);

/**
 * Resolve every desktop glyph from Lucide. Unknown names stay visible through
 * Lucide's question marker so a package rename cannot create a blank control
 * or silently introduce a different visual family.
 */
const desktopIconResolver: IconLibraryResolver = (name) => {
  const svg = lucideSvg(LUCIDE_NAME_BY_TEXRA_NAME[name] ?? name);
  return svg ? svgDataUri(svg) : missingIconUri;
};

registerIconLibrary(TEXRA_ICON_LIBRARY, { resolver: desktopIconResolver });
registerIconLibrary('default', { resolver: desktopIconResolver });
