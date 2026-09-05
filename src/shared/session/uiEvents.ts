/**
 * The three events a shell component dispatches. Each carries one arm of
 * the record it changes, unchanged, as its `detail`: a `RuntimeRequest` for
 * the session runtime, a `HostRequest` for a host capability, and a
 * `SurfaceAction` for the surface the root owns. The root installs one
 * listener per event; nothing translates in between (PRD 8, identity
 * translation), and a harness that assigns fixtures simply ignores them.
 */
import type { HostRequest } from './hostRequest';
import type { RuntimeRequest } from './runtimeRequest';
import type { SurfaceAction } from './surface';

const SESSION_UI_EVENT = {
  runtime: 'runtime-request',
  host: 'host-request',
  surface: 'surface-action',
} as const;

function uiEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

export const SessionUiEvents = {
  runtime: (detail: RuntimeRequest) =>
    uiEvent(SESSION_UI_EVENT.runtime, detail),
  host: (detail: HostRequest) => uiEvent(SESSION_UI_EVENT.host, detail),
  surface: (detail: SurfaceAction) => uiEvent(SESSION_UI_EVENT.surface, detail),
};

declare global {
  interface HTMLElementEventMap {
    'runtime-request': CustomEvent<RuntimeRequest>;
    'host-request': CustomEvent<HostRequest>;
    'surface-action': CustomEvent<SurfaceAction>;
  }
}
