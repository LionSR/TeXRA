/**
 * The progress webview's root wiring (PRD one-fold-three-renderers, 7.7, 8,
 * 9): the one place the three records meet the `<progress-app>` element.
 * `view` comes from the fold over the transport, `host` from the frames,
 * and `surface` is owned here: loaded from the view's persisted state,
 * pruned on every view change, saved on every surface change. One listener
 * per shell event forwards the arm it carries; the response of a request
 * lands back on the surface (a follow-up rejected keeps its draft, a picker
 * returns its paths, a polish its text).
 */
import { signal } from '@lit-labs/signals';
import { subscribeToSignalChanges } from '@shared/signals';
import type { HostRequest } from '@shared/session/hostRequest';
import type { Response } from '@shared/session/sessionFrames';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import {
  applySurfaceAction,
  loadSurface,
  persistSurface,
  PersistedSurfaceSchema,
  pruneSurface,
  resolveSelected,
  type Surface,
  type SurfaceAction,
} from '@shared/session/surface';
import type { RuntimeRequestDetail } from '@shared/session/uiEvents';

import { PersistedState } from '@shared/state/PersistedState';
import { LAUNCH_FILE_LISTS } from '@shared/launcher/fileSelectConfigs';

import {
  installWebviewTransport,
  transcriptAggregates,
  type WebviewSession,
} from './sessionTransport';
import { webviewStorage } from './webviewStorage';
import type { ProgressApp } from './ProgressApp';

/** The launcher field a picker's paths return to. */
const SINGLE_FILE_FIELDS = { base: 'baseFile', edited: 'editedFile' } as const;

function requestId(): string {
  return crypto.randomUUID();
}

/** Where a picked path list lands on the launch surface. */
function withPickedPaths(
  launch: Surface['launch'],
  fileType: Extract<HostRequest, { kind: 'pickFiles' }>['fileType'],
  paths: readonly string[],
): Partial<Surface['launch']> {
  if (fileType === 'base' || fileType === 'edited') {
    const path = paths[0];
    return path === undefined ? {} : { [SINGLE_FILE_FIELDS[fileType]]: path };
  }
  const field = LAUNCH_FILE_LISTS[fileType];
  return { [field]: [...new Set([...launch[field], ...paths])] };
}

export function mountProgressWebview(app: ProgressApp): void {
  const sessionKey = app.dataset.session;
  if (!sessionKey) {
    throw new Error('<progress-app> is missing its data-session key');
  }
  const transport = installWebviewTransport();
  const session: WebviewSession = transport.open(sessionKey);
  const persisted = new PersistedState(
    webviewStorage,
    `surface:${sessionKey}`,
    PersistedSurfaceSchema,
  );
  const surface$ = signal<Surface>(
    loadSurface(sessionKey, persisted.getState()),
  );
  let subscribedTranscript = '';

  /** The transcript tier follows the resolved selection (C7). */
  function subscribeTranscript(): void {
    const view = session.view$.get();
    const aggregates = transcriptAggregates(
      view,
      resolveSelected(view, surface$.get()),
    );
    const key = aggregates.map((entry) => entry.id).join('/');
    if (key === subscribedTranscript && session.generation > 0) return;
    subscribedTranscript = key;
    transport.subscribe(session, aggregates);
  }

  function setSurface(next: Surface): void {
    if (next === surface$.get()) return;
    surface$.set(next);
    persisted.setState(persistSurface(next));
  }

  function act(action: SurfaceAction): void {
    setSurface(applySurfaceAction(surface$.get(), action));
  }

  function selectedStreamId(): string | null {
    return resolveSelected(session.view$.get(), surface$.get());
  }

  /** The response of a `runtime.request`, folded onto the surface. */
  function settleRuntime(
    request: RuntimeRequest,
    result: Response['result'],
  ): void {
    if (result.ok || request.kind !== 'followUp.send') return;
    // A rejected follow-up keeps its draft (8.4): the composer cleared it
    // optimistically on send.
    act({
      kind: 'draft',
      streamId: request.streamId,
      patch: { text: request.text },
    });
  }

  /** The response of a `host.request`, folded onto the surface. */
  function settleHost(request: HostRequest, result: Response['result']): void {
    const streamId = selectedStreamId();
    const launch = surface$.get().launch;
    if (!result.ok) {
      if (request.kind === 'polish') {
        // The composer clears its polishing state when a polished variant
        // lands; a failed polish lands the text itself.
        setDraftText(streamId, launch, 'polished', request.text);
      }
      return;
    }
    const { outcome } = result;
    switch (request.kind) {
      case 'pickFiles':
      case 'useCurrentFile':
      case 'addOpenedFiles':
      case 'attachDroppedFiles': {
        if (outcome.kind !== 'files') return;
        const fileType =
          request.kind === 'attachDroppedFiles'
            ? request.category
            : request.fileType;
        act({
          kind: 'launch',
          patch: withPickedPaths(launch, fileType, outcome.paths),
        });
        return;
      }
      case 'polish':
        if (outcome.kind === 'text') {
          setDraftText(streamId, launch, 'polished', outcome.text);
        }
        return;
      case 'record':
        if (outcome.kind === 'text') {
          setDraftText(streamId, launch, 'transcribed', outcome.text);
        }
        return;
      case 'launch':
        // The host reveals the stream it started through `surface.action`;
        // the instruction draft is spent.
        act({
          kind: 'launch',
          patch: {
            instruction: { ...launch.instruction, [launch.sessionType]: '' },
          },
        });
        return;
      default:
        return;
    }
  }

  /** A polished or transcribed text lands on the selected stream's draft,
   *  or on the launcher's instruction in the New-task state. */
  function setDraftText(
    streamId: string | null,
    launch: Surface['launch'],
    variant: 'polished' | 'transcribed',
    text: string,
  ): void {
    if (streamId !== null) {
      act({ kind: 'draft', streamId, patch: { [variant]: text } });
      return;
    }
    const current = launch.instruction[launch.sessionType];
    const appended = current ? `${current.replace(/\s+$/, '')} ${text}` : text;
    const next = variant === 'polished' ? text : appended;
    act({
      kind: 'launch',
      patch: {
        instruction: { ...launch.instruction, [launch.sessionType]: next },
      },
    });
  }

  app.addEventListener('runtime-request', (event) => {
    const request = event.detail as RuntimeRequestDetail as RuntimeRequest;
    void transport
      .request({
        kind: 'runtime.request',
        session: sessionKey,
        requestId: requestId(),
        request,
      })
      .then((result) => settleRuntime(request, result));
  });
  app.addEventListener('host-request', (event) => {
    const request = event.detail;
    void transport
      .request({
        kind: 'host.request',
        session: sessionKey,
        requestId: requestId(),
        request,
      })
      .then((result) => settleHost(request, result));
  });
  app.addEventListener('surface-action', (event) => act(event.detail));
  transport.onSurfaceAction((key, action) => {
    if (key !== sessionKey) return;
    if (action.kind === 'submitLaunch') {
      // The run accelerator: send the launcher's instruction as the composer would.
      const launch = surface$.get().launch;
      const instruction = launch.instruction[launch.sessionType].trim();
      if (instruction === '') return;
      app.dispatchEvent(
        new CustomEvent<HostRequest>('host-request', {
          detail: { kind: 'launch', instruction },
        }),
      );
      return;
    }
    act(action);
  });

  const assign = (): void => {
    const view = session.view$.get();
    const surface = pruneSurface(surface$.get(), view);
    setSurface(surface);
    app.view = view;
    app.surface = surface;
    app.host = session.host$.get();
    app.nowMs = Date.now();
    subscribeTranscript();
  };
  const unsubscribe = subscribeToSignalChanges(
    [session.view$, surface$, session.host$],
    assign,
  );
  const clock = window.setInterval(() => {
    app.nowMs = Date.now();
  }, 1000);
  assign();

  window.addEventListener(
    'pagehide',
    () => {
      window.clearInterval(clock);
      unsubscribe();
      transport.dispose();
    },
    { once: true },
  );
}
