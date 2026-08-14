// Interactive terminal pane (xterm.js front end over a main-process pty).
//
// xterm.js was already a dependency, used read-only by progressView's
// TerminalOutput to replay captured agent output. This pane is the interactive
// counterpart: keystrokes go to a real pty, so the user can run builds, git, or
// `lake` without leaving the app.
//
// Sizing note: xterm cannot measure a `display:none` container, so `fit()` must
// run after the pane becomes visible, not when the session starts. The shell
// calls layout() on tab activation for exactly this reason.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import xtermStyles from '@xterm/xterm/css/xterm.css?inline';

import { resolveXtermTheme } from '@shared/wa/xtermTheme';

import { getDesktopChromeFontSize } from './desktopTypography';

export interface TerminalPaneCallbacks {
  /** Requests a pty for `sessionId` at the measured geometry. */
  start(sessionId: string, cols: number, rows: number): void;
  sendInput(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  close(sessionId: string): void;
}

export interface TerminalPane {
  readonly element: HTMLElement;
  /**
   * Shows `sessionId`, creating its terminal and pty on first use. `focus`
   * (default `true`) moves keyboard focus into the terminal; pass `false`
   * from layout passes, which must re-fit without stealing focus.
   */
  activate(sessionId: string, options?: { focus?: boolean }): void;
  /** Feeds pty output into the matching terminal. */
  write(sessionId: string, data: string): void;
  /** Reports process exit in-band so the pane doesn't look merely idle. */
  reportExit(sessionId: string, exitCode: number): void;
  reportError(sessionId: string, message: string): void;
  /** Re-fits the active terminal; call after the pane becomes visible. */
  layout(): void;
  dispose(sessionId: string): void;
  disposeAll(): void;
}

interface TerminalSession {
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
  readonly host: HTMLElement;
  started: boolean;
  exited: boolean;
}

/**
 * xterm ships its CSS as a stylesheet rather than shadow-scoped styles. The
 * pane renders in the light DOM, so inject once at document level.
 */
let stylesInjected = false;

function injectXtermStyles(): void {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.dataset.texraXterm = 'true';
  style.textContent = xtermStyles;
  document.head.append(style);
  stylesInjected = true;
}

export function createTerminalPane(
  callbacks: TerminalPaneCallbacks,
): TerminalPane {
  injectXtermStyles();

  const element = document.createElement('div');
  element.className = 'desktop-terminal-pane';

  const sessions = new Map<string, TerminalSession>();
  let activeSessionId: string | undefined;

  function createSession(sessionId: string): TerminalSession {
    const host = document.createElement('div');
    host.className = 'desktop-terminal-surface';
    element.append(host);

    const { theme, fontFamily } = resolveXtermTheme(document.body);
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily,
      fontSize: getDesktopChromeFontSize(),
      // Build logs and test output are long; a shallow buffer would discard the
      // beginning of exactly the runs users need to read.
      scrollback: 10_000,
      // Pty output is canvas-only without this; screen reader mode exposes the
      // buffer (including the in-band exit/error lines) as text.
      screenReaderMode: true,
      theme,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    terminal.onData((data) => callbacks.sendInput(sessionId, data));
    terminal.onResize(({ cols, rows }) =>
      callbacks.resize(sessionId, cols, rows),
    );

    const session: TerminalSession = {
      terminal,
      fitAddon,
      host,
      started: false,
      exited: false,
    };
    sessions.set(sessionId, session);
    return session;
  }

  function fit(session: TerminalSession): void {
    try {
      session.fitAddon.fit();
    } catch {
      // fit() throws when the container has no layout box yet (hidden tab).
      // Harmless: layout() runs again once the pane is visible.
    }
  }

  function disposeSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    callbacks.close(sessionId);
    session.terminal.dispose();
    session.host.remove();
    sessions.delete(sessionId);
    if (activeSessionId === sessionId) activeSessionId = undefined;
  }

  return {
    element,

    activate(sessionId, { focus = true }: { focus?: boolean } = {}) {
      const session = sessions.get(sessionId) ?? createSession(sessionId);
      activeSessionId = sessionId;
      for (const [id, entry] of sessions) {
        entry.host.hidden = id !== sessionId;
      }
      fit(session);
      if (!session.started) {
        session.started = true;
        // Start only once the terminal has real geometry, so the shell's first
        // prompt is wrapped for the correct width.
        const { cols, rows } = session.terminal;
        callbacks.start(sessionId, Math.max(cols, 20), Math.max(rows, 5));
      }
      if (focus) session.terminal.focus();
    },

    write(sessionId, data) {
      sessions.get(sessionId)?.terminal.write(data);
    },

    reportExit(sessionId, exitCode) {
      const session = sessions.get(sessionId);
      if (!session || session.exited) return;
      session.exited = true;
      // Written into the buffer rather than shown as a toast: it belongs with
      // the output it terminates.
      session.terminal.write(
        `\r\n\u001b[90m[process exited with code ${exitCode}]\u001b[0m\r\n`,
      );
    },

    reportError(sessionId, message) {
      const session = sessions.get(sessionId) ?? createSession(sessionId);
      session.terminal.write(`\r\n\u001b[31m${message}\u001b[0m\r\n`);
    },

    layout() {
      const session = activeSessionId
        ? sessions.get(activeSessionId)
        : undefined;
      if (session) fit(session);
    },

    dispose: disposeSession,

    disposeAll() {
      for (const sessionId of [...sessions.keys()]) {
        disposeSession(sessionId);
      }
    },
  };
}
