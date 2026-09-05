/**
 * The open sessions of one webview (PRD one-fold-three-renderers, 7.7, 8,
 * 9, 12.2): one fold per session on the one webview runtime, one `Surface`
 * per session owned and persisted here, and the request round trip whose
 * responses land back on the surface (a follow-up rejected keeps its
 * draft, a picker returns its paths, a polish its text). The sidebar and
 * the editor tab hold one session; the Electron renderer holds one per
 * open paper. A root assigns each session's three records to its shell and
 * forwards the shell's events here; nothing else reaches the runtime or
 * the host bridge for a session.
 */
import { signal, type Signal } from '@lit-labs/signals';

import type { StateStore } from '@platform/interfaces';
import { subscribeToSignalChanges } from '@shared/signals';
import { LAUNCH_FILE_LISTS } from '@shared/launcher/fileSelectConfigs';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import type { Response } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
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
import { PersistedState } from '@shared/state/PersistedState';

import {
  installWebviewTransport,
  transcriptAggregates,
  type WebviewSession,
} from './sessionTransport';

/** One open session as the root holds it: its three records as signals. */
interface SessionSurface {
  readonly key: string;
  readonly view$: Signal.State<SessionView>;
  readonly surface$: Signal.State<Surface>;
  readonly host$: Signal.State<HostSnapshot | null>;
}

export interface SessionSurfaces {
  /** One host-bridge message: true when it was a session message. */
  receive(data: unknown): boolean;
  /** Open the sessions the host names and close the rest. */
  sync(keys: readonly string[]): void;
  get(key: string): SessionSurface | undefined;
  list(): readonly SessionSurface[];
  /** Apply a surface action to one session's surface. */
  act(key: string, action: SurfaceAction): void;
  runtimeRequest(key: string, request: RuntimeRequest): void;
  hostRequest(key: string, request: HostRequest): void;
  /** Fires after any session's view, surface, or host changed. */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

/** The launcher field a picker's paths return to. */
const SINGLE_FILE_FIELDS = { base: 'baseFile', edited: 'editedFile' } as const;

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

export function createSessionSurfaces(options: {
  readonly storage: StateStore;
}): SessionSurfaces {
  const transport = installWebviewTransport();
  interface Held extends SessionSurface {
    readonly session: WebviewSession;
    readonly persisted: PersistedState<
      ReturnType<typeof PersistedSurfaceSchema.parse>
    >;
    subscribedTranscript: string;
    unsubscribe(): void;
  }
  const held = new Map<string, Held>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function requestId(): string {
    return crypto.randomUUID();
  }

  /** The transcript tier follows the resolved selection (C7). */
  function subscribeTranscript(entry: Held): void {
    const view = entry.view$.get();
    const aggregates = transcriptAggregates(
      view,
      resolveSelected(view, entry.surface$.get()),
    );
    const transcript = aggregates.map((aggregate) => aggregate.id).join('/');
    if (
      transcript === entry.subscribedTranscript &&
      entry.session.generation > 0
    ) {
      return;
    }
    entry.subscribedTranscript = transcript;
    transport.subscribe(entry.session, aggregates);
  }

  function setSurface(entry: Held, next: Surface): void {
    if (next === entry.surface$.get()) return;
    entry.surface$.set(next);
    entry.persisted.setState(persistSurface(next));
  }

  function act(entry: Held, action: SurfaceAction): void {
    setSurface(entry, applySurfaceAction(entry.surface$.get(), action));
  }

  function open(key: string): Held {
    const session = transport.open(key);
    const persisted = new PersistedState(
      options.storage,
      `surface:${key}`,
      PersistedSurfaceSchema,
    );
    const surface$ = signal<Surface>(loadSurface(key, persisted.getState()));
    const entry: Held = {
      key,
      view$: session.view$,
      surface$,
      host$: session.host$,
      session,
      persisted,
      subscribedTranscript: '',
      unsubscribe: () => undefined,
    };
    // The per-stream maps drop what the view no longer holds (PRD 9), and
    // the transcript subscription follows the selection.
    entry.unsubscribe = subscribeToSignalChanges(
      [session.view$, surface$, session.host$],
      () => {
        setSurface(
          entry,
          pruneSurface(entry.surface$.get(), session.view$.get()),
        );
        subscribeTranscript(entry);
        notify();
      },
    );
    held.set(key, entry);
    subscribeTranscript(entry);
    return entry;
  }

  /** The response of a `runtime.request`, folded onto the surface. */
  function settleRuntime(
    entry: Held,
    request: RuntimeRequest,
    result: Response['result'],
  ): void {
    if (result.ok || request.kind !== 'followUp.send') return;
    // A rejected follow-up keeps its draft (8.4): the composer cleared it
    // optimistically on send.
    act(entry, {
      kind: 'draft',
      streamId: request.streamId,
      patch: { text: request.text },
    });
  }

  /** A polished or transcribed text lands on the selected stream's draft,
   *  or on the launcher's instruction in the New-task state. */
  function setDraftText(
    entry: Held,
    variant: 'polished' | 'transcribed',
    text: string,
  ): void {
    const surface = entry.surface$.get();
    const streamId = resolveSelected(entry.view$.get(), surface);
    if (streamId !== null) {
      act(entry, { kind: 'draft', streamId, patch: { [variant]: text } });
      return;
    }
    const { launch } = surface;
    const current = launch.instruction[launch.sessionType];
    let next = text;
    if (variant === 'transcribed' && current) {
      next = `${current.replace(/\s+$/, '')} ${text}`;
    }
    act(entry, {
      kind: 'launch',
      patch: {
        instruction: { ...launch.instruction, [launch.sessionType]: next },
      },
    });
  }

  /** The response of a `host.request`, folded onto the surface. */
  function settleHost(
    entry: Held,
    request: HostRequest,
    result: Response['result'],
  ): void {
    if (!result.ok) {
      // The composer clears its polishing state when a polished variant
      // lands; a failed polish lands the text itself.
      if (request.kind === 'polish') {
        setDraftText(entry, 'polished', request.text);
      }
      return;
    }
    const { outcome } = result;
    const { launch } = entry.surface$.get();
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
        act(entry, {
          kind: 'launch',
          patch: withPickedPaths(launch, fileType, outcome.paths),
        });
        return;
      }
      case 'polish':
        if (outcome.kind === 'text') {
          setDraftText(entry, 'polished', outcome.text);
        }
        return;
      case 'record':
        if (outcome.kind === 'text') {
          setDraftText(entry, 'transcribed', outcome.text);
        }
        return;
      case 'launch':
        // The host reveals the stream it started through `surface.action`;
        // the instruction draft is spent.
        act(entry, {
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

  function hostRequestFor(entry: Held, hostRequest: HostRequest): void {
    void transport
      .request({
        kind: 'host.request',
        session: entry.key,
        requestId: requestId(),
        request: hostRequest,
      })
      .then((result) => settleHost(entry, hostRequest, result));
  }

  transport.onSurfaceAction((key, action) => {
    const entry = held.get(key);
    if (!entry) return;
    if (action.kind === 'submitLaunch') {
      // The run accelerator: send the launcher's instruction as the
      // composer would.
      const { launch } = entry.surface$.get();
      const instruction = launch.instruction[launch.sessionType].trim();
      if (instruction !== '') {
        hostRequestFor(entry, { kind: 'launch', launch, instruction });
      }
      return;
    }
    act(entry, action);
  });

  return {
    receive: transport.receive,
    sync(keys) {
      // A closed session's surface stays persisted for its next opening;
      // its graph is released with the transport, once, on dispose.
      for (const [key, entry] of held) {
        if (keys.includes(key)) continue;
        held.delete(key);
        entry.unsubscribe();
      }
      for (const key of keys) {
        if (!held.has(key)) open(key);
      }
      notify();
    },
    get: (key) => held.get(key),
    list: () => [...held.values()],
    act(key, action) {
      const entry = held.get(key);
      if (entry) act(entry, action);
    },
    runtimeRequest(key, request) {
      const entry = held.get(key);
      if (!entry) return;
      void transport
        .request({
          kind: 'runtime.request',
          session: key,
          requestId: requestId(),
          request,
        })
        .then((result) => settleRuntime(entry, request, result));
    },
    hostRequest(key, hostRequest) {
      const entry = held.get(key);
      if (entry) hostRequestFor(entry, hostRequest);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const entry of held.values()) entry.unsubscribe();
      held.clear();
      transport.dispose();
    },
  };
}
