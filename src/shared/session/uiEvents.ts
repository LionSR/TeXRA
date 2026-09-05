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

/**
 * Arms named by PRD 8.2 and not yet in `RuntimeRequestSchema`; the
 * components dispatch them under the same event until the schema gains
 * them (the handler side lands with `SessionRequests`).
 */
export type RuntimeRequestDetail =
  | RuntimeRequest
  | { readonly kind: 'stream.resume'; readonly streamId: string }
  | { readonly kind: 'stream.runNew'; readonly streamId: string }
  | {
      readonly kind: 'decision.toolEdit';
      readonly streamId: string;
      readonly approvalId: string;
      readonly decision:
        | { readonly action: 'approve' }
        | { readonly action: 'reject'; readonly feedback?: string | null };
    }
  | {
      readonly kind: 'externalInquiry.submit';
      readonly streamId: string;
      readonly threadId: string;
      readonly answer: string;
      readonly sessionLinks?: readonly string[] | null;
    }
  | {
      readonly kind: 'externalInquiry.drop';
      readonly streamId: string;
      readonly threadId: string;
      readonly feedback?: string | null;
    }
  | {
      readonly kind: 'credentials.useOwnApiKey';
      readonly streamId: string;
      readonly approvalId: string;
      readonly model?: string | null;
      readonly provider?: string | null;
      readonly exhaustionReason?: string | null;
      readonly kimiCodeRoutedOnFailure?: boolean | null;
    }
  | { readonly kind: 'misc.runCompileFixer'; readonly streamId: string };

const SESSION_UI_EVENT = {
  runtime: 'runtime-request',
  host: 'host-request',
  surface: 'surface-action',
} as const;

function uiEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

export const SessionUiEvents = {
  runtime: (detail: RuntimeRequestDetail) =>
    uiEvent(SESSION_UI_EVENT.runtime, detail),
  host: (detail: HostRequest) => uiEvent(SESSION_UI_EVENT.host, detail),
  surface: (detail: SurfaceAction) => uiEvent(SESSION_UI_EVENT.surface, detail),
};

declare global {
  interface HTMLElementEventMap {
    'runtime-request': CustomEvent<RuntimeRequestDetail>;
    'host-request': CustomEvent<HostRequest>;
    'surface-action': CustomEvent<SurfaceAction>;
  }
}
