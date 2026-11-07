// Third-party imports
import { Effect, Schema } from 'effect';
import { signal } from '@lit-labs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { emptySessionView } from '@shared/session/sessionView';
import {
  buildScenario,
  viewOf,
  ROOT,
} from '@test/shared/session/fanOutScenario';
import { type HostSnapshot } from '@texra/shared/session/hostSnapshot';
import { PersistedSurfaceSchema } from '@texra/shared/session/surface';
import {
  createWebviewStorage,
  type KeyValueStore,
} from '@texra/shared/state/PersistedState';
import { createSessionSurfaces } from '@ui/progress/sessionSurfaces';
import type { WebviewTransport } from '@ui/progress/sessionTransport';
import type { RuntimeCommand } from '@texra-ai/harness/schemas';
import { Rejected } from '@texra-ai/harness/schemas';

const transport = vi.hoisted(() => ({
  receive: vi.fn(),
  open: vi.fn(),
  subscribe: vi.fn(),
  runtimeRequest: vi.fn<WebviewTransport['runtimeRequest']>(),
  hostRequest: vi.fn<WebviewTransport['hostRequest']>(),
  // The session's scope is the test's: a request runs to its answer.
  run: vi.fn<WebviewTransport['run']>((_session, program) => {
    void Effect.runPromise(program);
  }),
  onSurfaceAction: vi.fn(),
  close: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@ui/progress/sessionTransport', async (original) => ({
  ...(await original<typeof import('@ui/progress/sessionTransport')>()),
  installWebviewTransport: () => transport,
}));

const KEY = 'paper';
let surfaces: ReturnType<typeof createSessionSurfaces>;
let storage: KeyValueStore;
let webviewState: unknown;
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
      runs: [[ROOT, { draft: 'Saved text', groups: [] }]],
    }),
  };
  storage = createWebviewStorage({
    getState: () => webviewState,
    setState: (state) => {
      webviewState = state;
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

/** The next request of `kind` waits for the answer the test gives it. */
function response<K extends 'runtimeRequest' | 'hostRequest'>(
  kind: K,
): (answer: ReturnType<WebviewTransport[K]>) => void {
  const { promise, resolve } =
    Promise.withResolvers<Effect.Effect<unknown, unknown>>();
  // cast: the answer is this member's own Effect, which TypeScript cannot
  // match to `transport[kind]` through the generic.
  (
    transport[kind] as unknown as { mockReturnValueOnce(value: unknown): void }
  ).mockReturnValueOnce(Effect.flatten(Effect.promise(() => promise)));
  return resolve;
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
    response('hostRequest');
    surfaces.submit(KEY);
    expect(transport.hostRequest.mock.calls[0]?.[0]).toMatchObject({
      request: { kind: 'launch', launch: { approval: 'autoApprove' } },
    });
    expect(surfaces.get(KEY)?.surface$.get().launch.approval).toBe('policy');
  });

  it('starts one task when Send is pressed again before the host admits it', async () => {
    surfaces.act(KEY, { kind: 'select', runId: null });
    surfaces.act(KEY, { kind: 'launch', patch: { instruction: 'Proofread' } });
    const admit = response('hostRequest');
    surfaces.submit(KEY);
    surfaces.submit(KEY);
    expect(transport.hostRequest).toHaveBeenCalledOnce();
    admit(Effect.succeed({ kind: 'done' }));
    await vi.waitFor(() =>
      expect(surfaces.get(KEY)?.surface$.get().sending.size).toBe(0),
    );
  });

  it('retains the complete draft on rejected admission and clears only an unchanged accepted draft', async () => {
    view.set(viewOf(buildScenario().events));
    const image = { fileName: 'figure.png', media: '/pasted/figure.png' };
    surfaces.act(KEY, {
      kind: 'draft',
      runId: ROOT,
      patch: { images: [image] },
    });
    const request: Extract<RuntimeCommand, { kind: 'followUp.send' }> = {
      kind: 'followUp.send',
      runId: ROOT,
      text: 'Saved text',
      media: [image.media],
    };
    const reject = response('runtimeRequest');
    surfaces.runtimeRequest(KEY, request);
    surfaces.runtimeRequest(KEY, request);
    expect(transport.runtimeRequest).toHaveBeenCalledOnce();
    surfaces.act(KEY, {
      kind: 'draft',
      runId: ROOT,
      patch: { text: 'New text' },
    });
    reject(Effect.fail(new Rejected({ reason: 'Unavailable' })));
    await vi.waitFor(() =>
      expect(surfaces.get(KEY)?.surface$.get().requestError).toEqual(
        new Rejected({ reason: 'Unavailable' }),
      ),
    );
    expect(surfaces.get(KEY)?.surface$.get().runs.get(ROOT)?.draft).toEqual({
      text: 'New text',
      images: [image],
    });

    const acceptEdited = response('runtimeRequest');
    surfaces.runtimeRequest(KEY, { ...request, text: 'New text' });
    surfaces.act(KEY, {
      kind: 'draft',
      runId: ROOT,
      patch: { text: 'Later text' },
    });
    acceptEdited(Effect.succeed({ kind: 'done' }));
    await vi.waitFor(() =>
      expect(surfaces.get(KEY)?.surface$.get().runs.get(ROOT)?.draft).toEqual({
        text: 'Later text',
        images: [image],
      }),
    );

    const accept = response('runtimeRequest');
    surfaces.runtimeRequest(KEY, { ...request, text: 'Later text' });
    accept(Effect.succeed({ kind: 'done' }));
    await vi.waitFor(() =>
      expect(surfaces.get(KEY)?.surface$.get().runs.get(ROOT)?.draft).toEqual({
        text: '',
        images: [],
      }),
    );
  });
});
