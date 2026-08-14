// Terminal feature discovery via the DA1-sentinel pattern.
//
// We write a batch of capability queries (Kitty keyboard protocol, OSC color
// reads) followed by `CSI c` (Device Attributes 1). Every terminal answers
// DA1, so any feature whose reply lands before the DA1 response is supported.
// There are no *per-capability* timeouts — only an outer 250ms safeguard for
// terminals that fail to answer DA1 at all, so startup never blocks.
//
// Pattern adapted from Claude Code's `src/ink/terminal-querier.ts` per
// docs/prds/cli-tui-ink/2026-05-14-10-architecture.md (Terminal capability discovery).
//
// This module is the source of truth for the `terminalCapabilities` signal
// consumed by the notifier (capability-gating OSC 9 / 99 / BEL) and future
// input-layer features (Kitty keyboard).

import { signal } from '@lit-labs/signals';

export interface TerminalCapabilities {
  /** Kitty keyboard progressive enhancement protocol (`CSI ? u`). */
  readonly kittyKeyboard: boolean;
  /** OSC 4 (color table) is honored — proxy for OSC-family support. */
  readonly oscColorReports: boolean;
}

const NONE: TerminalCapabilities = {
  kittyKeyboard: false,
  oscColorReports: false,
};

export const terminalCapabilities = signal<TerminalCapabilities>(NONE);

// Queries to write — each must produce a response before DA1 if supported.
// The order matches the response order so we can scan for response markers.
const QUERIES = {
  kittyKeyboard: '[?u',
  oscColorReports: ']4;0;?',
} as const satisfies Record<keyof TerminalCapabilities, string>;

const DA1_SENTINEL = '[c';

// Response markers we look for in the read buffer (before the DA1 reply).
// The `\x1b` (ESC) is mandatory in every CSI/OSC reply — that's exactly
// what `no-control-regex` flags; the rule is paranoid for terminal-protocol
// patterns. Suppression is scoped to this block.
/* eslint-disable no-control-regex */
const RESPONSE_MARKERS = {
  // Kitty keyboard: `CSI ? <flags> u`
  kittyKeyboard: /\[\?[\d;]*u/,
  // OSC 4 color: `OSC 4 ; <index> ; rgb:... BEL` (or ST)
  oscColorReports: /\]4;0;rgb:/,
} as const satisfies Record<keyof typeof QUERIES, RegExp>;

// DA1 response: `CSI ? <attrs> c`
const DA1_RESPONSE = /\[\?[\d;]*c/;
/* eslint-enable no-control-regex */

export interface DiscoveryStreams {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

/**
 * Run terminal capability discovery once at startup. Returns the resolved
 * capabilities; also publishes to the `terminalCapabilities` signal so
 * consumers can read it lazily.
 *
 * Times out after ~250ms. A terminal that fails to answer DA1 is a serious
 * outlier; we degrade to "no advanced features" rather than block startup.
 */
export async function discoverTerminalCapabilities(
  streams: DiscoveryStreams,
): Promise<TerminalCapabilities> {
  if (!streams.stdin.isTTY || !streams.stdout.isTTY) {
    terminalCapabilities.set(NONE);
    return NONE;
  }

  const queryString = Object.values(QUERIES).join('') + DA1_SENTINEL;

  const wasRaw = streams.stdin.isRaw;
  streams.stdin.setRawMode?.(true);
  streams.stdin.resume();

  const result = await new Promise<string>((resolve) => {
    let buffer = '';
    let settled = false;
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      buffer += chunk.toString('utf8');
      if (DA1_RESPONSE.test(buffer)) {
        settled = true;
        cleanup();
        resolve(buffer);
      }
    };
    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buffer);
    };
    const timer = setTimeout(onTimeout, 250);
    const cleanup = (): void => {
      clearTimeout(timer);
      streams.stdin.off('data', onData);
    };
    streams.stdin.on('data', onData);
    streams.stdout.write(queryString);
  });

  if (!wasRaw) streams.stdin.setRawMode?.(false);

  const caps: TerminalCapabilities = {
    kittyKeyboard: RESPONSE_MARKERS.kittyKeyboard.test(result),
    oscColorReports: RESPONSE_MARKERS.oscColorReports.test(result),
  };
  terminalCapabilities.set(caps);
  return caps;
}
