// Banner rendered at the very top of a chat session.
//
// Ink only supports one `<Static>` per app (the ConversationPane already
// owns it for the transcript), so we can't render the banner through Ink
// — a second Static would be silently dropped. Instead this module returns
// the formatted banner string; the CLI boundary writes it to stdout before
// Ink mounts, placing it in the real terminal scrollback above the live region.
//
// Keep this deliberately plain: the TUI should start with useful session
// information, not a large decorative logo.

import os from 'node:os';
import path from 'node:path';

import pc from 'picocolors';

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

export function renderHeaderBanner(info: HeaderBannerInfo): string {
  const lines = [
    `${pc.bold(pc.cyan('TeXRA'))} ${pc.dim(`v${info.version}`)}`,
    `${pc.cyan(info.agent || 'chat')} ${pc.dim('·')} ${info.model || '—'}`,
    pc.dim(shortenCwd(info.cwd)),
  ];
  return `\n${lines.join('\n')}\n\n`;
}
