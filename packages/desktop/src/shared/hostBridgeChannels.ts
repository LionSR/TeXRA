/** The `desktop:*` and settings-view commands: renderer to main, and back. */
export const ELECTRON_WEBVIEW_MESSAGE_CHANNEL = 'texra:webview-message';
export const ELECTRON_WEBVIEW_PUSH_CHANNEL = 'texra:webview-push';

/** The session protocol's own pair (PRD 8): `UpMessage`s to main and
 *  `DownMessage`s back. Nothing on it is a command, so neither end tells the
 *  two apart by shape. */
export const ELECTRON_SESSION_MESSAGE_CHANNEL = 'texra:session-message';
export const ELECTRON_SESSION_PUSH_CHANNEL = 'texra:session-push';

/** Global key where the preload exposes the session channel to the renderer. */
export const SESSION_WIRE_API_KEY = '__texraDesktopSessionWire';

/** The renderer's end of the session channel: a pipe, no decoding. */
export interface SessionWireApi {
  post(message: unknown): void;
  /** Replaces the previous listener; the renderer's one transport reads it.
   *  Pushes that arrived before the first listener reach it, in order. */
  onMessage(listener: (message: unknown) => void): void;
}

/** Global key where the preload exposes the shell's push readiness. */
export const DESKTOP_PUSHES_API_KEY = '__texraDesktopPushes';

/** Main connects a window before its page has evaluated, so the preload holds
 *  every webview push until the shell's window listener exists. */
export interface DesktopPushesApi {
  /** The shell listens: post the held pushes, in order, then every later one. */
  listening(): void;
}

function resolvePreloadApi<T>(key: string, name: string): T {
  const api = (globalThis as Record<string, unknown>)[key];
  if (!api) throw new Error(`The desktop ${name} is unavailable.`);
  return api as T;
}

/** The preload's session channel, as the renderer finds it. */
export const resolveSessionWire = (): SessionWireApi =>
  resolvePreloadApi(SESSION_WIRE_API_KEY, 'session channel');

/** The preload's push channel, as the shell finds it. */
export const resolveDesktopPushes = (): DesktopPushesApi =>
  resolvePreloadApi(DESKTOP_PUSHES_API_KEY, 'push channel');
