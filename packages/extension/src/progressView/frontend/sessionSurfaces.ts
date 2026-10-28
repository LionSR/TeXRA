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
import { Schema } from 'effect';

import { RequestErrorSchema } from '@texra-ai/harness/schemas';

import type { HostRequest } from '@texra/shared/session/hostRequest';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Response, UpMessage } from '@texra/shared/session/sessionFrames';
import {
  applySurfaceAction,
  canSendFollowUp,
  EMPTY_DRAFT,
  loadSurface,
  persistSurface,
  PersistedSurfaceSchema,
  pruneSurface,
  reconcileLaunch,
  type Surface,
  type SurfaceAction,
} from '@texra/shared/session/surface';
import {
  PersistedState,
  type KeyValueStore,
} from '@texra/shared/state/PersistedState';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import { LAUNCH_FILE_LISTS } from '@ui/copy/fileSelectConfigs';

import { editedProposal, proposalApproval } from './proposalEdit';
import {
  installWebviewTransport,
  transcriptAggregates,
  type WebviewSession,
  type WebviewTransport,
} from './sessionTransport';
import type {
  SessionView,
  RuntimeRequest,
  RunId,
} from '@texra-ai/harness/schemas';

/** A short beep for a run the host decided to chime for. Autoplay
 *  restrictions and a missing audio device are expected, not fatal, but the
 *  cause is logged so a regressing AudioContext path is not invisible. */
function playCompletionSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 150);
  } catch (error) {
    console.warn('Failed to play completion sound:', error);
  }
}

/** One open session as the root holds it: its three records as signals. */
interface SessionSurface {
  readonly key: string;
  readonly view$: Signal.State<SessionView>;
  readonly surface$: Signal.State<Surface>;
  readonly host$: Signal.State<HostSnapshot | null>;
}

export interface SessionSurfaces {
  /** One message from the host's session channel. */
  receive(data: unknown): void;
  /** Open the sessions the host names and close the rest. */
  sync(keys: readonly string[]): void;
  get(key: string): SessionSurface | undefined;
  /** Apply a surface action to one session's surface. */
  act(key: string, action: SurfaceAction): void;
  runtimeRequest(key: string, request: RuntimeRequest): void;
  hostRequest(key: string, request: HostRequest): void;
  /** A host request answered to its caller, not presented on the surface. */
  answer: WebviewTransport['answer'];
  /** The composer's Send for the resolved selection: a follow-up to the
   *  selected run, else a launch from the launcher's instruction. The
   *  button and the run accelerator both land here. */
  submit(key: string): void;
  /** Fires after any session's view, surface, or host changed. */
  onChange(listener: () => void): () => void;
  /** Record the run the `shown` session shows as seen after every change
   *  and when the window regains focus, but only while the window has
   *  focus: a run finishing behind another app is news when the user comes
   *  back. Returns the unsubscribe. */
  followSeen(shown: () => string): () => void;
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
  readonly storage: KeyValueStore;
  readonly post: (message: UpMessage) => void;
}): SessionSurfaces {
  const transport = installWebviewTransport(options.post);
  interface Held extends SessionSurface {
    readonly session: WebviewSession;
    readonly persisted: PersistedState<typeof PersistedSurfaceSchema.Type>;
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
      entry.surface$.get().selected,
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

  function open(key: string): void {
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
    // The per-run maps drop what the view no longer holds (PRD 9), the
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
  }

  /** An asynchronous operation keeps the draft that started it, even if
   *  selection changes before its response. */
  interface DraftOrigin {
    readonly runId: RunId | null;
  }

  function draftText(entry: Held, origin: DraftOrigin): string {
    const surface = entry.surface$.get();
    return origin.runId === null
      ? surface.launch.instruction
      : (surface.drafts.get(origin.runId)?.text ?? '');
  }

  function setDraftText(entry: Held, origin: DraftOrigin, text: string): void {
    if (origin.runId !== null) {
      // A completed operation cannot recreate a deleted conversation.
      if (!entry.view$.get().runs.has(origin.runId)) return;
      act(entry, { kind: 'draft', runId: origin.runId, patch: { text } });
      return;
    }
    act(entry, { kind: 'launch', patch: { instruction: text } });
  }

  /** A refused request's error as its class; null for success and for a
   *  cancellation, which needs no notice. The message was decoded whole, so
   *  the error's wire form always decodes: a failure here is a defect. */
  function refusal(result: Response['result']): Surface['requestError'] {
    if (result.ok) return null;
    const error = Schema.decodeUnknownSync(RequestErrorSchema)(result.error);
    return error._tag === 'Cancelled' ? null : error;
  }

  function presentResult(entry: Held, result: Response['result']): void {
    const error = refusal(result);
    if (error !== null) {
      setSurface(entry, { ...entry.surface$.get(), requestError: error });
    }
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
        if (origin.runId === null) {
          act(entry, {
            kind: 'launch',
            patch: withPickedPaths(launch, 'media', [outcome.fileName]),
          });
          return;
        }
        const draft = entry.surface$.get().drafts.get(origin.runId);
        if (!draft) return;
        act(entry, {
          kind: 'draft',
          runId: origin.runId,
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
        if (launch.instruction === request.launch.instruction) {
          act(entry, { kind: 'launch', patch: { instruction: '' } });
        }
        return;
      default:
        return;
    }
  }

  /** A refusal is the surface's to show, on every host: the wire carries
   *  its reason and its guide link. */
  function settleHostResponse(
    entry: Held,
    request: HostRequest,
    origin: DraftOrigin,
    result: Response['result'],
  ): void {
    presentResult(entry, result);
    settleHost(entry, request, origin, result);
  }

  async function hostRequestFor(
    entry: Held,
    request: HostRequest,
  ): Promise<void> {
    const surface = entry.surface$.get();
    let runId = surface.selected;
    if (request.kind === 'record' && request.action.kind === 'start') {
      runId = request.action.target === 'launch' ? null : request.action.target;
    }
    const origin: DraftOrigin = { runId };
    const target = origin.runId ?? 'launch';
    if (request.kind === 'polish') {
      if (surface.polishing.has(target)) return;
      setSurface(entry, {
        ...surface,
        polishing: new Set([...surface.polishing, target]),
      });
    }
    // A second Send before the host admits the launch would start a
    // second run, so the launch claims its stream like a follow-up does.
    if (request.kind === 'launch') {
      if (surface.sending.has('launch')) return;
      setSurface(entry, {
        ...surface,
        sending: new Set([...surface.sending, 'launch']),
      });
    }
    const result = await transport.request({
      kind: 'host.request',
      session: entry.key,
      requestId: requestId(),
      request,
    });
    if (held.get(entry.key) !== entry) return;
    if (request.kind === 'polish') {
      const current = entry.surface$.get();
      const polishing = new Set(current.polishing);
      polishing.delete(target);
      setSurface(entry, { ...current, polishing });
    }
    if (request.kind === 'launch') {
      const current = entry.surface$.get();
      const sending = new Set(current.sending);
      sending.delete('launch');
      setSurface(entry, { ...current, sending });
    }
    settleHostResponse(entry, request, origin, result);
  }

  async function runtimeRequestFor(
    entry: Held,
    request: RuntimeRequest,
  ): Promise<void> {
    const { key } = entry;
    const runId = 'runId' in request ? request.runId : null;
    if (request.kind === 'followUp.send') {
      const current = entry.surface$.get();
      if (current.sending.has(request.runId)) return;
      setSurface(entry, {
        ...current,
        sending: new Set([...current.sending, request.runId]),
      });
    }
    // A new request on the run retires the answer to the last one.
    if (runId !== null && entry.surface$.get().rejected.has(runId)) {
      const current = entry.surface$.get();
      const rejected = new Map(current.rejected);
      rejected.delete(runId);
      setSurface(entry, { ...current, rejected });
    }
    // Keep text and images until admission succeeds. A rejection needs
    // no restoration, and a later edit remains independent of this send.
    const submitted =
      request.kind === 'followUp.send'
        ? entry.surface$.get().drafts.get(request.runId)
        : undefined;
    // Read before the answer: the view may retire the request, and the
    // form's hold on it, before the response arrives.
    const fromForm =
      request.kind === 'request.decide' &&
      entry.surface$.get().editing?.requestId === request.requestId;
    const result = await transport.request({
      kind: 'runtime.request',
      session: key,
      requestId: requestId(),
      request,
    });
    if (held.get(key) !== entry) return;
    presentResult(entry, result);
    // The runtime's refusal also reaches the run it was made on
    // (7.6): that run's controls paint it, and nothing here
    // swallows it.
    const error = refusal(result);
    if (error !== null && runId !== null) {
      const current = entry.surface$.get();
      setSurface(entry, {
        ...current,
        rejected: new Map(current.rejected).set(runId, error),
      });
    }
    // The form's approval went through: back to the run that asked, where
    // its child starts.
    if (result.ok && fromForm) {
      act(entry, { kind: 'launch', patch: { instruction: '' } });
      act(entry, { kind: 'select', runId: request.runId });
    }
    if (request.kind !== 'followUp.send') return;
    const current = entry.surface$.get();
    const sending = new Set(current.sending);
    sending.delete(request.runId);
    setSurface(entry, { ...current, sending });
    if (!result.ok) return;
    if (
      submitted !== undefined &&
      entry.surface$.get().drafts.get(request.runId) === submitted
    ) {
      act(entry, {
        kind: 'draft',
        runId: request.runId,
        patch: EMPTY_DRAFT,
      });
    }
  }

  /** A follow-up sends once the host has stored every pasted image; an
   *  empty draft, like an empty launcher instruction, sends nothing. */
  function submit(entry: Held): void {
    const surface = entry.surface$.get();
    const view = entry.view$.get();
    const runId = surface.selected;
    if (runId !== null) {
      const run = view.runs.get(runId);
      const draft = surface.drafts.get(runId) ?? EMPTY_DRAFT;
      // The same decision the composer's Send takes, from the same fold
      // fields: a run that ended or that another process owns takes no
      // follow-up, however the send was reached.
      if (!run || !canSendFollowUp(run, draft)) return;
      const text = draft.text.trim();
      const mediaFiles = draft.images.flatMap((image) =>
        image.path === null ? [] : [image.path],
      );
      void runtimeRequestFor(entry, {
        kind: 'followUp.send',
        runId,
        text: text === '' ? '(image)' : text,
        mediaFiles: mediaFiles.length > 0 ? mediaFiles : null,
      });
      return;
    }
    const { launch } = surface;
    const instruction = launch.instruction.trim();
    if (instruction === '') return;
    // Open on a proposal, the form approves it with the form's changes.
    const edited = editedProposal(surface, view);
    if (edited !== null) {
      const { data } = edited;
      // A task works over its input or media files, as `document_task` asks.
      if (
        data.task &&
        launch.inputFiles.length === 0 &&
        launch.mediaFiles.length === 0
      ) {
        act(entry, {
          kind: 'reportError',
          reason: 'Choose an input or media file first.',
        });
        return;
      }
      void runtimeRequestFor(entry, {
        kind: 'request.decide',
        runId: data.runId,
        requestId: data.requestId,
        decision: proposalApproval(data, { ...launch, instruction }),
      });
      return;
    }
    // Auto-approve is this launch's alone: the request carries it, and the
    // request settles only with the run, so the next task must not find it.
    if (launch.approval !== 'policy')
      act(entry, { kind: 'launch', patch: { approval: 'policy' } });
    void hostRequestFor(entry, { kind: 'launch', launch, instruction });
  }

  transport.onSurfaceAction((key, action) => {
    const entry = held.get(key);
    if (!entry) return;
    // The host already decided a chime's transition and chose this port.
    if (action.kind === 'chime') playCompletionSound();
    else if (action.kind === 'submit') submit(entry);
    else if (action.kind === 'draft')
      act(entry, {
        kind: 'draft',
        runId: action.runId,
        patch: { text: action.text, images: action.images },
      });
    else if (action.kind !== 'showSessions') act(entry, action);
    // Show Sessions opens the newest session only from the New-task state.
    else if (entry.surface$.get().selected === null) {
      act(entry, { kind: 'select', runId: action.runId });
    }
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
    act(key, action) {
      const entry = held.get(key);
      if (entry) act(entry, action);
    },
    runtimeRequest(key, request) {
      const entry = held.get(key);
      if (entry) void runtimeRequestFor(entry, request);
    },
    answer: transport.answer,
    hostRequest(key, hostRequest) {
      const entry = held.get(key);
      if (entry) void hostRequestFor(entry, hostRequest);
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
    followSeen(shown) {
      const markSeen = () => {
        const entry = held.get(shown());
        if (entry && document.hasFocus()) {
          act(entry, { kind: 'seen', view: entry.view$.get() });
        }
      };
      listeners.add(markSeen);
      window.addEventListener('focus', markSeen);
      return () => {
        listeners.delete(markSeen);
        window.removeEventListener('focus', markSeen);
      };
    },
    dispose() {
      for (const entry of held.values()) entry.unsubscribe();
      held.clear();
      transport.dispose();
    },
  };
}
