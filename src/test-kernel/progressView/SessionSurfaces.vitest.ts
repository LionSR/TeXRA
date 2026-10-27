// Third-party imports
import { Schema } from 'effect';
import { signal } from '@lit-labs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { createSessionSurfaces } from '@progressView/frontend/sessionSurfaces';
import type { WebviewTransport } from '@progressView/frontend/sessionTransport';
import { Rejected, type RuntimeRequest } from '@shared/session/runtimeRequest';
import { emptySessionView } from '@shared/session/sessionView';
import {
  buildScenario,
  viewOf,
  ROOT,
} from '@test/shared/session/fanOutScenario';
import { type HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Response } from '@texra/shared/session/sessionFrames';
import { PersistedSurfaceSchema } from '@texra/shared/session/surface';
import {
  createWebviewStorage,
  type KeyValueStore,
} from '@texra/shared/state/PersistedState';

const transport = vi.hoisted(() => ({
  receive: vi.fn(),
  open: vi.fn(),
  subscribe: vi.fn(),
  request: vi.fn<WebviewTransport['request']>(),
  onSurfaceAction: vi.fn(),
  close: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@progressView/frontend/sessionTransport', async (original) => ({
  ...(await original<
    typeof import('@progressView/frontend/sessionTransport')
  >()),
  installWebviewTransport: () => transport,
}));

const KEY = 'paper';
let surfaces: ReturnType<typeof createSessionSurfaces>;
let storage: KeyValueStore;
let webviewState: Record<string, unknown>;
let view: ReturnType<typeof signal<ReturnType<typeof emptySessionView>>>;
let host: ReturnType<typeof signal<HostSnapshot | null>>;

beforeEach(() => {
  vi.clearAllMocks();
  view = signal(emptySessionView(KEY));
  host = signal<HostSnapshot | null>(null);
  // The surface's storage is the renderer's SYNCHRONOUS `KeyValueStore`, so
  // the suite builds it the way a renderer does rather than handing it an
  // Effect-shaped store: returning an Effect where `void` is expected is
  // assignable, which would let a discarded write look correct here.
  webviewState = {
    [`surface:${KEY}`]: Schema.decodeUnknownSync(PersistedSurfaceSchema)({
      selected: ROOT,
      drafts: [[ROOT, 'Saved text']],
    }),
  };
  storage = createWebviewStorage({
    getState: () => webviewState,
    setState: (state) => {
      webviewState = state as Record<string, unknown>;
    },
  });
  transport.open.mockReturnValue({
    key: KEY,
    view$: view,
    host$: host,
    generation: 1,
  });
  surfaces = createSessionSurfaces({ storage, post: vi.fn() });
  surfaces.sync([KEY]);
});

afterEach(() => surfaces.dispose());

function response(): (result: Response['result']) => void {
  let resolve!: (result: Response['result']) => void;
  transport.request.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  return (result) => resolve(result);
}

describe('session Surface ownership', () => {
  it('ends a per-task auto-approve with the launch it was chosen for (#13342)', () => {
    surfaces.act(KEY, { kind: 'select', runId: null });
    surfaces.act(KEY, {
      kind: 'launch',
      patch: { instruction: 'Proofread', approval: 'autoApprove' },
    });
    // The launch request settles only with its run: the next task must not
    // inherit the choice while it runs.
    response();
    surfaces.submit(KEY);
    expect(transport.request.mock.calls[0]?.[0]).toMatchObject({
      request: { kind: 'launch', launch: { approval: 'autoApprove' } },
    });
    expect(surfaces.get(KEY)?.surface$.get().launch.approval).toBe('policy');
  });

  it('starts one task when Send is pressed again before the host admits it', async () => {
    surfaces.act(KEY, { kind: 'select', runId: null });
    surfaces.act(KEY, { kind: 'launch', patch: { instruction: 'Proofread' } });
    const admit = response();
    surfaces.submit(KEY);
    surfaces.submit(KEY);
    expect(transport.request).toHaveBeenCalledOnce();
    admit({ ok: true, outcome: { kind: 'done' } });
    await Promise.resolve();
    expect(surfaces.get(KEY)?.surface$.get().sending.size).toBe(0);
  });

  it('retains the complete draft on rejected admission and clears only an unchanged accepted draft', async () => {
    view.set(viewOf(buildScenario().events));
    const image = { fileName: 'figure.png', path: '/pasted/figure.png' };
    surfaces.act(KEY, {
      kind: 'draft',
      runId: ROOT,
      patch: { images: [image] },
    });
    const request: Extract<RuntimeRequest, { kind: 'followUp.send' }> = {
      kind: 'followUp.send',
      runId: ROOT,
      text: 'Saved text',
      mediaFiles: [image.path],
    };
    const reject = response();
    surfaces.runtimeRequest(KEY, request);
    surfaces.runtimeRequest(KEY, request);
    expect(transport.request).toHaveBeenCalledOnce();
    surfaces.act(KEY, {
      kind: 'draft',
      runId: ROOT,
      patch: { text: 'New text' },
    });
    reject({ ok: false, error: { _tag: 'Rejected', reason: 'Unavailable' } });
    await Promise.resolve();
    expect(surfaces.get(KEY)?.surface$.get().requestError).toEqual(
      new Rejected({ reason: 'Unavailable' }),
    );
    expect(surfaces.get(KEY)?.surface$.get().drafts.get(ROOT)).toEqual({
      text: 'New text',
      images: [image],
    });

    const acceptEdited = response();
    surfaces.runtimeRequest(KEY, { ...request, text: 'New text' });
    surfaces.act(KEY, {
      kind: 'draft',
      runId: ROOT,
      patch: { text: 'Later text' },
    });
    acceptEdited({ ok: true, outcome: { kind: 'done' } });
    await Promise.resolve();
    expect(surfaces.get(KEY)?.surface$.get().drafts.get(ROOT)).toEqual({
      text: 'Later text',
      images: [image],
    });

    const accept = response();
    surfaces.runtimeRequest(KEY, { ...request, text: 'Later text' });
    accept({ ok: true, outcome: { kind: 'done' } });
    await Promise.resolve();
    expect(surfaces.get(KEY)?.surface$.get().drafts.get(ROOT)).toEqual({
      text: '',
      images: [],
    });
  });
});
