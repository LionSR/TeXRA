// Third-party imports
import { signal } from '@lit-labs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { createSessionSurfaces } from '@progressView/frontend/sessionSurfaces';
import type { WebviewTransport } from '@progressView/frontend/sessionTransport';
import {
  emptyHostSnapshot,
  type HostSnapshot,
} from '@shared/session/hostSnapshot';
import type { HostRequest } from '@shared/session/hostRequest';
import type { Response } from '@shared/session/sessionFrames';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { emptySessionView } from '@shared/session/sessionView';
import { PersistedSurfaceSchema } from '@shared/session/surface';
import { FakeStateStore } from '@test/support/FakePlatform';
import {
  buildScenario,
  CHILD,
  foldAll,
  ROOT,
} from '@test/shared/session/fanOutScenario';

const transport = vi.hoisted(() => ({
  receive: vi.fn(),
  open: vi.fn(),
  subscribe: vi.fn(),
  request: vi.fn<WebviewTransport['request']>(),
  onSurfaceAction: vi.fn(),
  onReaderFailure: vi.fn(),
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
let storage: FakeStateStore;
let view: ReturnType<typeof signal<ReturnType<typeof emptySessionView>>>;
let host: ReturnType<typeof signal<HostSnapshot | null>>;

beforeEach(() => {
  vi.clearAllMocks();
  view = signal(emptySessionView(KEY));
  host = signal<HostSnapshot | null>(null);
  storage = new FakeStateStore({
    [`surface:${KEY}`]: PersistedSurfaceSchema.parse({
      selected: ROOT,
      drafts: [[ROOT, 'Saved text']],
    }),
  });
  transport.open.mockReturnValue({
    key: KEY,
    view$: view,
    host$: host,
    generation: 1,
  });
  surfaces = createSessionSurfaces({
    storage,
    hostRequestFailureOwner: 'surface',
  });
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
  it.each(['host', 'surface'] as const)(
    'routes host refusals to the %s owner and leaves cancellation quiet',
    async (hostRequestFailureOwner) => {
      surfaces.dispose();
      surfaces = createSessionSurfaces({ storage, hostRequestFailureOwner });
      surfaces.sync([KEY]);
      const cancel = response();
      surfaces.hostRequest(KEY, { kind: 'pickFiles', fileType: 'input' });
      cancel({ ok: false, error: { _tag: 'Cancelled' } });
      await Promise.resolve();
      expect(surfaces.get(KEY)?.surface$.get().requestError).toBeNull();

      const refuse = response();
      surfaces.hostRequest(KEY, { kind: 'compileInputPdf' });
      // Open another paper while the first paper's request remains pending.
      surfaces.sync([KEY, 'other-paper']);
      const error = {
        _tag: 'Rejected',
        reason: 'Compiling the input PDF is unavailable.',
      } as const;
      refuse({ ok: false, error });
      await Promise.resolve();
      expect(surfaces.get(KEY)?.surface$.get().requestError).toBe(
        hostRequestFailureOwner === 'surface' ? error : null,
      );
      expect(
        surfaces.get('other-paper')?.surface$.get().requestError,
      ).toBeNull();
      surfaces.act(KEY, { kind: 'dismissRequestError' });
      expect(surfaces.get(KEY)?.surface$.get().requestError).toBeNull();
    },
  );

  it('releases the graph of a session that leaves the sync set', () => {
    surfaces.sync([]);
    expect(transport.close).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(surfaces.get(KEY)).toBeUndefined();
  });

  it('keeps persisted drafts through host updates before listing replay, then prunes authoritative absence', async () => {
    host.set(
      emptyHostSnapshot({
        key: KEY,
        name: 'Paper',
        initials: 'P',
        subtitle: '/paper',
      }),
    );
    await Promise.resolve();
    expect(surfaces.get(KEY)?.surface$.get().drafts.get(ROOT)?.text).toBe(
      'Saved text',
    );
    expect(
      storage.get<ReturnType<typeof PersistedSurfaceSchema.parse>>(
        `surface:${KEY}`,
      ).drafts,
    ).toEqual([[ROOT, 'Saved text']]);

    view.set(foldAll(buildScenario().events));
    await Promise.resolve();
    expect(surfaces.get(KEY)?.surface$.get().drafts.get(ROOT)?.text).toBe(
      'Saved text',
    );
    view.set(emptySessionView(KEY));
    await Promise.resolve();
    expect(
      storage.get<ReturnType<typeof PersistedSurfaceSchema.parse>>(
        `surface:${KEY}`,
      ).drafts,
    ).toEqual([]);
  });

  it('retains the complete draft on rejected admission and clears only an unchanged accepted draft', async () => {
    view.set(foldAll(buildScenario().events));
    const image = { fileName: 'figure.png', path: '/pasted/figure.png' };
    surfaces.act(KEY, {
      kind: 'draft',
      streamId: ROOT,
      patch: { images: [image] },
    });
    const request: Extract<RuntimeRequest, { kind: 'followUp.send' }> = {
      kind: 'followUp.send',
      streamId: ROOT,
      text: 'Saved text',
      mediaFiles: [image.path],
    };
    const reject = response();
    surfaces.runtimeRequest(KEY, request);
    surfaces.runtimeRequest(KEY, request);
    expect(transport.request).toHaveBeenCalledOnce();
    surfaces.act(KEY, {
      kind: 'draft',
      streamId: ROOT,
      patch: { text: 'New text' },
    });
    reject({ ok: false, error: { _tag: 'Rejected', reason: 'Unavailable' } });
    await Promise.resolve();
    expect(surfaces.get(KEY)?.surface$.get().requestError).toEqual({
      _tag: 'Rejected',
      reason: 'Unavailable',
    });
    expect(surfaces.get(KEY)?.surface$.get().drafts.get(ROOT)).toEqual({
      text: 'New text',
      images: [image],
    });

    const acceptEdited = response();
    surfaces.runtimeRequest(KEY, { ...request, text: 'New text' });
    surfaces.act(KEY, {
      kind: 'draft',
      streamId: ROOT,
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

  it.each([
    ['polish', 'stream'],
    ['record', 'stream'],
    ['polish', 'launch'],
    ['record', 'launch'],
  ] as const)(
    'returns %s to its originating %s draft after selection changes',
    async (operation, target) => {
      view.set(foldAll(buildScenario().events));
      const isLaunch = target === 'launch';
      if (isLaunch) {
        surfaces.act(KEY, { kind: 'selectNew' });
        surfaces.act(KEY, {
          kind: 'launch',
          patch: {
            sessionType: 'toolUse',
            instruction: { toolUse: 'Saved text' },
          },
        });
      }
      const finish = response();
      const request: HostRequest =
        operation === 'polish'
          ? { kind: 'polish', text: 'Saved text' }
          : {
              kind: 'record',
              action: { kind: 'start', target: isLaunch ? 'launch' : ROOT },
            };
      surfaces.hostRequest(KEY, request);
      if (isLaunch) {
        surfaces.act(KEY, {
          kind: 'launch',
          patch: {
            sessionType: 'workflow',
            instruction: { workflow: 'Other text' },
          },
        });
      } else {
        surfaces.act(KEY, { kind: 'select', streamId: CHILD });
        surfaces.act(KEY, {
          kind: 'draft',
          streamId: CHILD,
          patch: { text: 'Other text' },
        });
      }
      finish({ ok: true, outcome: { kind: 'text', text: 'Result' } });
      await Promise.resolve();
      const surface = surfaces.get(KEY)!.surface$.get();
      expect(
        isLaunch
          ? surface.launch.instruction.toolUse
          : surface.drafts.get(ROOT)?.text,
      ).toBe(operation === 'polish' ? 'Result' : 'Saved text Result');
      expect(
        isLaunch
          ? surface.launch.instruction.workflow
          : surface.drafts.get(CHILD)?.text,
      ).toBe('Other text');
      expect(surface.polishing.size).toBe(0);
    },
  );
});
