// The renderer's open sessions (PRD one-fold-three-renderers, 7.7, 8, 9,
// 12.2): one fold per open paper on the one webview runtime, one `Surface`
// per paper owned and persisted here, and the request round trip. The
// renderer root (`main.ts`) assigns each paper's three records to the rail
// and the conversation shell and forwards the shell's events here; nothing
// else in the renderer reaches the runtime or the host bridge for a session.

import { signal, type Signal } from '@lit-labs/signals';
import { z } from 'zod';

import type { StateStore } from '@platform/interfaces';
import {
  installWebviewTransport,
  transcriptAggregates,
  type WebviewSession,
} from '@progressView/frontend/sessionTransport';
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
import type { RuntimeRequestDetail } from '@shared/session/uiEvents';
import { PersistedState } from '@shared/state/PersistedState';

/** One open paper as the renderer holds it: its three records as signals. */
interface PaperSession {
  readonly key: string;
  readonly view$: Signal.State<SessionView>;
  readonly surface$: Signal.State<Surface>;
  readonly host$: Signal.State<HostSnapshot | null>;
}

export interface PaperSessions {
  /** Open the papers the main process lists and close the rest. */
  sync(keys: readonly string[]): void;
  get(key: string): PaperSession | undefined;
  list(): readonly PaperSession[];
  /** Apply a surface action to one paper's surface. */
  act(key: string, action: SurfaceAction): void;
  runtimeRequest(key: string, request: RuntimeRequestDetail): void;
  hostRequest(key: string, request: HostRequest): void;
  /** Fires after any paper's view, surface, or host changed. */
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

/**
 * The renderer's own interaction state survives a reload in
 * `localStorage`; the preload bridge's `getState` is in-memory only.
 */
export function rendererStateStore(storage: Storage): StateStore {
  return {
    get<T>(key: string, defaultValue?: T): T {
      const raw = storage.getItem(key);
      if (raw === null) return defaultValue as T;
      return JSON.parse(raw) as T;
    },
    update(key, value) {
      if (value === undefined) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
      return Promise.resolve();
    },
  };
}

const SurfacePersistenceSchema = PersistedSurfaceSchema as z.ZodType<
  z.infer<typeof PersistedSurfaceSchema>
>;

export function createPaperSessions(options: {
  readonly storage: StateStore;
}): PaperSessions {
  // The same transport, runtime, and fold the extension's webview mounts:
  // one graph per open paper on the one webview runtime.
  const transport = installWebviewTransport();
  interface Held extends PaperSession {
    readonly session: WebviewSession;
    readonly persisted: PersistedState<z.infer<typeof PersistedSurfaceSchema>>;
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
  function subscribeTranscript(paper: Held): void {
    const view = paper.view$.get();
    const aggregates = transcriptAggregates(
      view,
      resolveSelected(view, paper.surface$.get()),
    );
    const transcript = aggregates.map((entry) => entry.id).join('/');
    if (
      transcript === paper.subscribedTranscript &&
      paper.session.generation > 0
    ) {
      return;
    }
    paper.subscribedTranscript = transcript;
    transport.subscribe(paper.session, aggregates);
  }

  function setSurface(paper: Held, next: Surface): void {
    if (next === paper.surface$.get()) return;
    paper.surface$.set(next);
    paper.persisted.setState(persistSurface(next));
  }

  function act(paper: Held, action: SurfaceAction): void {
    setSurface(paper, applySurfaceAction(paper.surface$.get(), action));
  }

  function open(key: string): Held {
    const session = transport.open(key);
    const persisted = new PersistedState(
      options.storage,
      `surface:${key}`,
      SurfacePersistenceSchema,
    );
    const surface$ = signal<Surface>(loadSurface(key, persisted.getState()));
    const paper: Held = {
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
    paper.unsubscribe = subscribeToSignalChanges(
      [session.view$, surface$, session.host$],
      () => {
        setSurface(
          paper,
          pruneSurface(paper.surface$.get(), session.view$.get()),
        );
        subscribeTranscript(paper);
        notify();
      },
    );
    held.set(key, paper);
    subscribeTranscript(paper);
    return paper;
  }

  /** The response of a `runtime.request`, folded onto the surface. */
  function settleRuntime(
    paper: Held,
    request: RuntimeRequestDetail,
    result: Response['result'],
  ): void {
    if (result.ok || request.kind !== 'followUp.send') return;
    // A rejected follow-up keeps its draft (8.4): the composer cleared it
    // optimistically on send.
    act(paper, {
      kind: 'draft',
      streamId: request.streamId,
      patch: { text: request.text },
    });
  }

  /** A polished or transcribed text lands on the selected stream's draft,
   *  or on the launcher's instruction in the New-task state. */
  function setDraftText(
    paper: Held,
    variant: 'polished' | 'transcribed',
    text: string,
  ): void {
    const surface = paper.surface$.get();
    const streamId = resolveSelected(paper.view$.get(), surface);
    if (streamId !== null) {
      act(paper, { kind: 'draft', streamId, patch: { [variant]: text } });
      return;
    }
    const { launch } = surface;
    const current = launch.instruction[launch.sessionType];
    let next = text;
    if (variant === 'transcribed' && current) {
      next = `${current.replace(/\s+$/, '')} ${text}`;
    }
    act(paper, {
      kind: 'launch',
      patch: {
        instruction: { ...launch.instruction, [launch.sessionType]: next },
      },
    });
  }

  /** The response of a `host.request`, folded onto the surface. */
  function settleHost(
    paper: Held,
    request: HostRequest,
    result: Response['result'],
  ): void {
    if (!result.ok) {
      // The composer clears its polishing state when a polished variant
      // lands; a failed polish lands the text itself.
      if (request.kind === 'polish')
        setDraftText(paper, 'polished', request.text);
      return;
    }
    const { outcome } = result;
    const { launch } = paper.surface$.get();
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
        act(paper, {
          kind: 'launch',
          patch: withPickedPaths(launch, fileType, outcome.paths),
        });
        return;
      }
      case 'polish':
        if (outcome.kind === 'text')
          setDraftText(paper, 'polished', outcome.text);
        return;
      case 'record':
        if (outcome.kind === 'text') {
          setDraftText(paper, 'transcribed', outcome.text);
        }
        return;
      case 'launch':
        // The host reveals the stream it started through `surface.action`;
        // the instruction draft is spent.
        act(paper, {
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

  transport.onSurfaceAction((key, action) => {
    const paper = held.get(key);
    if (!paper) return;
    if (action.kind === 'submitLaunch') {
      // The run accelerator: send the launcher's instruction as the
      // composer would.
      const { launch } = paper.surface$.get();
      const instruction = launch.instruction[launch.sessionType].trim();
      if (instruction !== '') {
        hostRequestFor(paper, { kind: 'launch', instruction });
      }
      return;
    }
    act(paper, action);
  });

  function hostRequestFor(paper: Held, hostRequest: HostRequest): void {
    void transport
      .request({
        kind: 'host.request',
        session: paper.key,
        requestId: requestId(),
        request: hostRequest,
      })
      .then((result) => settleHost(paper, hostRequest, result));
  }

  return {
    sync(keys) {
      // A closed paper's surface stays persisted for its next opening; its
      // graph is released with the transport, once, on dispose.
      for (const [key, paper] of held) {
        if (keys.includes(key)) continue;
        held.delete(key);
        paper.unsubscribe();
      }
      for (const key of keys) {
        if (!held.has(key)) open(key);
      }
      notify();
    },
    get: (key) => held.get(key),
    list: () => [...held.values()],
    act(key, action) {
      const paper = held.get(key);
      if (paper) act(paper, action);
    },
    runtimeRequest(key, detail) {
      const paper = held.get(key);
      if (!paper) return;
      void transport
        .request({
          kind: 'runtime.request',
          session: key,
          requestId: requestId(),
          request: detail as RuntimeRequest,
        })
        .then((result) => settleRuntime(paper, detail, result));
    },
    hostRequest(key, hostRequest) {
      const paper = held.get(key);
      if (paper) hostRequestFor(paper, hostRequest);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const paper of held.values()) paper.unsubscribe();
      held.clear();
      transport.dispose();
    },
  };
}
