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
import type { SessionType, StreamTabId } from '@shared/schemas';
import { subscribeToSignalChanges } from '@shared/signals';
import { LAUNCH_FILE_LISTS } from '@shared/launcher/fileSelectConfigs';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import type { Response } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
import {
  applySurfaceAction,
  EMPTY_DRAFT,
  loadSurface,
  persistSurface,
  PersistedSurfaceSchema,
  pruneSurface,
  reconcileLaunch,
  resolveSelected,
  type Surface,
  type SurfaceAction,
} from '@shared/session/surface';
import { PersistedState } from '@shared/state/PersistedState';

import { playCompletionSound } from './audioNotification';
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
  /** The composer's Send for the resolved selection: a follow-up to the
   *  selected stream, else a launch from the launcher's instruction. The
   *  button and the run accelerator both land here. */
  submit(key: string): void;
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
  function transcriptTier(entry: Held): {
    transcript: string;
    aggregates: ReturnType<typeof transcriptAggregates>;
  } {
    const view = entry.view$.get();
    const aggregates = transcriptAggregates(
      view,
      resolveSelected(view, entry.surface$.get()),
    );
    return {
      transcript: aggregates.map((aggregate) => aggregate.id).join('/'),
      aggregates,
    };
  }

  /** A new generation over the tier: on every open, then whenever the
   *  tier moves. */
  function subscribeTranscript(entry: Held): void {
    const { transcript, aggregates } = transcriptTier(entry);
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
    // The ref's initial value precedes listing replay. Only subsequent
    // publications have complete membership and can authorize pruning.
    const beforeReplay = session.view$.get();
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
    // The per-stream maps drop what the view no longer holds (PRD 9), the
    // launcher's selections follow the host's catalogs, and the transcript
    // subscription follows the selection.
    entry.unsubscribe = subscribeToSignalChanges(
      [session.view$, surface$, session.host$],
      () => {
        const view = session.view$.get();
        const host = session.host$.get();
        let next = entry.surface$.get();
        if (view !== beforeReplay) next = pruneSurface(next, view);
        if (host) next = reconcileLaunch(next, host);
        setSurface(entry, next);
        if (transcriptTier(entry).transcript !== entry.subscribedTranscript) {
          subscribeTranscript(entry);
        }
        notify();
      },
    );
    held.set(key, entry);
    subscribeTranscript(entry);
    return entry;
  }

  /** An asynchronous operation keeps the draft that started it, even if
   *  selection or the launcher's mode changes before its response. */
  interface DraftOrigin {
    readonly streamId: StreamTabId | null;
    readonly sessionType: SessionType;
  }

  function draftText(entry: Held, origin: DraftOrigin): string {
    const surface = entry.surface$.get();
    return origin.streamId === null
      ? surface.launch.instruction[origin.sessionType]
      : (surface.drafts.get(origin.streamId)?.text ?? '');
  }

  function setDraftText(entry: Held, origin: DraftOrigin, text: string): void {
    if (origin.streamId !== null) {
      // A completed operation cannot recreate a deleted conversation.
      if (!entry.view$.get().streams.has(origin.streamId)) return;
      act(entry, { kind: 'draft', streamId: origin.streamId, patch: { text } });
      return;
    }
    act(entry, {
      kind: 'launch',
      patch: { instruction: { [origin.sessionType]: text } },
    });
  }

  /** The response of a `host.request`, folded onto the surface. */
  function settleHost(
    entry: Held,
    request: HostRequest,
    origin: DraftOrigin,
    result: Response['result'],
  ): void {
    if (!result.ok) return;
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
      case 'savePastedImage': {
        if (outcome.kind !== 'savedImage') return;
        // The launcher has no image draft, so the stored file joins its
        // media list as a picker's paths would; a follow-up draft holds the
        // chip under the pasted name and the send carries the stored file.
        if (origin.streamId === null) {
          act(entry, {
            kind: 'launch',
            patch: withPickedPaths(launch, 'media', [outcome.fileName]),
          });
          return;
        }
        const draft = entry.surface$.get().drafts.get(origin.streamId);
        if (!draft) return;
        act(entry, {
          kind: 'draft',
          streamId: origin.streamId,
          patch: {
            images: draft.images.map((image) =>
              image.fileName === request.fileName
                ? { ...image, path: outcome.fileName }
                : image,
            ),
          },
        });
        return;
      }
      case 'polish':
        // A reply to an earlier text cannot replace edits made while it ran.
        if (
          outcome.kind === 'text' &&
          draftText(entry, origin).trim() === request.text
        ) {
          setDraftText(entry, origin, outcome.text);
        }
        return;
      case 'record':
        if (request.action.kind === 'start' && outcome.kind === 'text') {
          const current = draftText(entry, origin).trimEnd();
          setDraftText(
            entry,
            origin,
            current ? `${current} ${outcome.text}` : outcome.text,
          );
        }
        return;
      case 'launch':
        if (
          launch.instruction[request.launch.sessionType] ===
          request.launch.instruction[request.launch.sessionType]
        ) {
          act(entry, {
            kind: 'launch',
            patch: { instruction: { [request.launch.sessionType]: '' } },
          });
        }
        return;
      default:
        return;
    }
  }

  function hostRequestFor(entry: Held, request: HostRequest): void {
    const surface = entry.surface$.get();
    let streamId = resolveSelected(entry.view$.get(), surface);
    if (request.kind === 'record' && request.action.kind === 'start') {
      streamId =
        request.action.target === 'launch' ? null : request.action.target;
    }
    const origin: DraftOrigin = {
      streamId,
      sessionType: surface.launch.sessionType,
    };
    const target = origin.streamId ?? `launch:${origin.sessionType}`;
    if (request.kind === 'polish') {
      if (surface.polishing.has(target)) return;
      setSurface(entry, {
        ...surface,
        polishing: new Set([...surface.polishing, target]),
      });
    }
    void transport
      .request({
        kind: 'host.request',
        session: entry.key,
        requestId: requestId(),
        request,
      })
      .then((result) => {
        if (held.get(entry.key) !== entry) return;
        if (request.kind === 'polish') {
          const current = entry.surface$.get();
          const polishing = new Set(current.polishing);
          polishing.delete(target);
          setSurface(entry, { ...current, polishing });
        }
        settleHost(entry, request, origin, result);
      });
  }

  function runtimeRequestFor(entry: Held, request: RuntimeRequest): void {
    const { key } = entry;
    if (request.kind === 'followUp.send') {
      const current = entry.surface$.get();
      if (current.sending.has(request.streamId)) return;
      setSurface(entry, {
        ...current,
        sending: new Set([...current.sending, request.streamId]),
      });
    }
    // Keep text and images until admission succeeds. A rejection needs
    // no restoration, and a later edit remains independent of this send.
    const submitted =
      request.kind === 'followUp.send'
        ? entry.surface$.get().drafts.get(request.streamId)
        : undefined;
    void transport
      .request({
        kind: 'runtime.request',
        session: key,
        requestId: requestId(),
        request,
      })
      .then((result) => {
        if (held.get(key) !== entry || request.kind !== 'followUp.send') return;
        const current = entry.surface$.get();
        const sending = new Set(current.sending);
        sending.delete(request.streamId);
        setSurface(entry, { ...current, sending });
        if (!result.ok) return;
        if (
          submitted !== undefined &&
          entry.surface$.get().drafts.get(request.streamId) === submitted
        ) {
          act(entry, {
            kind: 'draft',
            streamId: request.streamId,
            patch: EMPTY_DRAFT,
          });
        }
      });
  }

  /** A follow-up sends once the host has stored every pasted image; an
   *  empty draft, like an empty launcher instruction, sends nothing. */
  function submit(entry: Held): void {
    const surface = entry.surface$.get();
    const streamId = resolveSelected(entry.view$.get(), surface);
    if (streamId !== null) {
      const draft = surface.drafts.get(streamId) ?? EMPTY_DRAFT;
      const text = draft.text.trim();
      if (text === '' && draft.images.length === 0) return;
      if (draft.images.some((image) => image.path === null)) return;
      const mediaFiles = draft.images.flatMap((image) =>
        image.path === null ? [] : [image.path],
      );
      runtimeRequestFor(entry, {
        kind: 'followUp.send',
        streamId,
        text: text === '' ? '(image)' : text,
        mediaFiles: mediaFiles.length > 0 ? mediaFiles : null,
      });
      return;
    }
    const { launch } = surface;
    const instruction = launch.instruction[launch.sessionType].trim();
    if (instruction === '') return;
    hostRequestFor(entry, { kind: 'launch', launch, instruction });
  }

  transport.onSurfaceAction((key, action) => {
    const entry = held.get(key);
    if (!entry) return;
    if (action.kind === 'chime') {
      // The host already decided the transition and chose this port.
      playCompletionSound();
      return;
    }
    if (action.kind === 'submit') {
      submit(entry);
      return;
    }
    act(entry, action);
  });

  return {
    receive: transport.receive,
    sync(keys) {
      // A closed session's surface stays persisted for its next opening;
      // its graph is released now, and its next opening builds a fresh one.
      for (const [key, entry] of held) {
        if (keys.includes(key)) continue;
        held.delete(key);
        entry.unsubscribe();
        transport.close(key);
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
      if (entry) runtimeRequestFor(entry, request);
    },
    hostRequest(key, hostRequest) {
      const entry = held.get(key);
      if (entry) hostRequestFor(entry, hostRequest);
    },
    submit(key) {
      const entry = held.get(key);
      if (entry) submit(entry);
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
