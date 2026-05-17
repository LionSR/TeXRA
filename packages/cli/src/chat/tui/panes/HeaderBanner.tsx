// Banner printed at the very top of a chat session.
//
// Ink only supports one `<Static>` per app (the ConversationPane already
// owns it for the transcript), so we can't render the banner through Ink
// — a second Static would be silently dropped. Instead we write the
// banner directly to stdout *before* Ink mounts, which places it in the
// real terminal scrollback above the live region.
//
// The pixel art is a rounded brain mascot with ∫ and Σ in the two
// hemispheres and a small smile underneath. Kept to four rows so it
// doesn't dominate the screen on tall sessions.

import os from 'node:os';
import path from 'node:path';

import pc from 'picocolors';

type Color = 'magenta' | 'cyan' | 'yellow' | 'white' | 'dim';
interface Segment {
  readonly text: string;
  readonly color?: Color;
  readonly bold?: boolean;
}

function paint(seg: Segment): string {
  let out = seg.text;
  switch (seg.color) {
    case 'magenta':
      out = pc.magenta(out);
      break;
    case 'cyan':
      out = pc.cyan(out);
      break;
    case 'yellow':
      out = pc.yellow(out);
      break;
    case 'white':
      out = pc.white(out);
      break;
    case 'dim':
      out = pc.dim(out);
      break;
    case undefined:
      break;
  }
  if (seg.bold) out = pc.bold(out);
  return out;
}

interface LogoRow {
  readonly text: string;
  readonly width: number;
}

// Visible width = sum of raw segment lengths (all glyphs in the logo
// are single-cell BMP characters, so `.length` matches column count).
// Reported alongside the ANSI-painted text so `printHeaderBanner` can
// right-pad rows to a uniform width without trying to strip the ANSI.
function row(...segments: Segment[]): LogoRow {
  return {
    text: segments.map(paint).join(''),
    width: segments.reduce((sum, s) => sum + s.text.length, 0),
  };
}

// 4-row brain mascot, oval/circular silhouette: narrow crown,
// widest in the middle, narrow chin. ∫ and Σ read as two "eyes"
// in the hemispheres, a centered fissure (│) splits the lobes,
// and a tiny yellow smile (◡) sits underneath.
const LOGO_ROWS: readonly LogoRow[] = [
  row({ text: '   ╭─╮', color: 'magenta' }),
  row(
    { text: '  ╱', color: 'magenta' },
    { text: '∫', color: 'white', bold: true },
    { text: '│', color: 'magenta' },
    { text: 'Σ', color: 'white', bold: true },
    { text: '╲', color: 'magenta' },
  ),
  row(
    { text: '  ╲ ', color: 'magenta' },
    { text: '◡', color: 'yellow' },
    { text: ' ╱', color: 'magenta' },
  ),
  row({ text: '   ╰─╯', color: 'magenta' }),
];

function shortenCwd(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return '~';
  // path.sep keeps the tilde shortening working on Windows, where
  // os.homedir() returns a backslash-separated path.
  const sep = path.sep;
  if (cwd.startsWith(`${home}${sep}`)) {
    return `~${sep}${cwd.slice(home.length + sep.length)}`;
  }
  return cwd;
}

export interface HeaderBannerInfo {
  readonly version: string;
  readonly agent: string;
  readonly model: string;
  readonly cwd: string;
}

export function printHeaderBanner(info: HeaderBannerInfo): void {
  const rightLines = [
    `${pc.bold('TeXRA')} ${pc.dim(`v${info.version}`)}`,
    `${pc.cyan(info.agent || 'chat')} ${pc.dim('·')} ${info.model || '—'}`,
    pc.dim(shortenCwd(info.cwd)),
    '',
  ];
  const gutter = '   ';
  const maxLogoWidth = Math.max(...LOGO_ROWS.map((r) => r.width));
  const lines = LOGO_ROWS.map((r, idx) => {
    const pad = ' '.repeat(maxLogoWidth - r.width);
    return `${r.text}${pad}${gutter}${rightLines[idx] ?? ''}`;
  });
  process.stdout.write(`\n${lines.join('\n')}\n\n`);
}
