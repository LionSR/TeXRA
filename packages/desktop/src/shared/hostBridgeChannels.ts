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
  /** Replaces the previous listener; the renderer's one transport reads it. */
  onMessage(listener: (message: unknown) => void): void;
}

/** The preload's session channel, as the renderer finds it. */
export function resolveSessionWire(): SessionWireApi {
  const wire = (globalThis as { [SESSION_WIRE_API_KEY]?: SessionWireApi })[
    SESSION_WIRE_API_KEY
  ];
  if (!wire) throw new Error('The desktop session channel is unavailable.');
  return wire;
}
