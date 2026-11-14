/**
 * The events a shell component dispatches. Three carry one case of the
 * record they change, unchanged, as their `detail`: a `RuntimeCommand` for
 * the session runtime, a `HostCommand` for a host capability, and a
 * `SurfaceAction` for the surface the root owns. The fourth, `submit`, is
 * the composer's Send: the root resolves what it sends (a follow-up to the
 * selected stream, or a launch) from the surface, so the button and the
 * run accelerator share one decision. The root installs one listener per
 * event; nothing translates in between, and
 * a harness that assigns fixtures simply ignores them.
 */
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { SurfaceAction } from '@texra/shared/session/surface';
import type { RuntimeCommand } from '@texra-ai/harness/schemas';

const SESSION_UI_EVENT = {
  runtime: 'runtime-request',
  host: 'host-request',
  surface: 'surface-action',
  submit: 'composer-submit',
} as const;

function uiEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

export const SessionUiEvents = {
  runtime: (detail: RuntimeCommand) =>
    uiEvent(SESSION_UI_EVENT.runtime, detail),
  host: (detail: HostCommand) => uiEvent(SESSION_UI_EVENT.host, detail),
  surface: (detail: SurfaceAction) => uiEvent(SESSION_UI_EVENT.surface, detail),
  submit: () => uiEvent(SESSION_UI_EVENT.submit, undefined),
};

declare global {
  interface HTMLElementEventMap {
    'runtime-request': CustomEvent<RuntimeCommand>;
    'host-request': CustomEvent<HostCommand>;
    'surface-action': CustomEvent<SurfaceAction>;
    'composer-submit': CustomEvent<undefined>;
  }
}
