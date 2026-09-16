// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, FileSystem, Layer } from 'effect';
import pDefer from 'p-defer';
import { expect, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import { apiKeySecretName } from '@model/apiProviders';
import { AppState } from '@platform/interfaces';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { Secrets } from '@platform/secrets';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';

const audio = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  transcribeRecording: vi.fn(),
  killActiveRecording: vi.fn(),
  recordingsDir: vi.fn(
    (roots: { storage: string }) => `${roots.storage}/recordings`,
  ),
}));

vi.mock('@tools/media/audio', () => audio);
vi.mock('@agent/runtime/textEnhancement', () => ({
  polishTextWithAI: vi.fn(),
}));

// The process stores `handle` resolves its models against: the polish model,
// and the OpenAI credential the take binds its transcription under, which is
// why the credential store carries a key.
const processStores = Layer.mergeAll(
  Secrets.layer(new FakeSecrets({ [apiKeySecretName('openai')]: 'sk-test' })),
  AppState.layer(new FakeStateStore()),
  FileSystem.layerNoop({}),
  // `polishTextWithAI` is mocked, but the request handler's type keeps the
  // real signature's `LanguageModel` requirement.
  LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
  testHttpClientLayer,
);

/** The same pair with no saved OpenAI key, so the take's credential read
 *  fails after the recorder has already been stopped. */
const storesWithoutCredential = Layer.mergeAll(
  Secrets.layer(new FakeSecrets()),
  AppState.layer(new FakeStateStore()),
  FileSystem.layerNoop({}),
  LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
  testHttpClientLayer,
);

it.effect(
  'returns transcription to Start when another paper stops the process recorder',
  () =>
    Effect.gen(function* () {
      const startup = pDefer<{ success: boolean }>();
      audio.startRecording.mockReturnValue(startup.promise);
      audio.stopRecording.mockResolvedValue({
        success: true,
        recordingPath: '/papers/first/recordings/take.wav',
      });
      audio.transcribeRecording.mockResolvedValue({
        success: true,
        text: 'A conserved quantity.',
      });
      const requests = new HostDraftRequests();
      const first = { roots: { storage: '/papers/first' } } as SessionHandle;
      const second = { roots: { storage: '/papers/second' } } as SessionHandle;
      const snapshot = vi.fn();
      const unsubscribe = requests.subscribe(snapshot);

      const started = yield* Effect.forkChild(
        requests.handle(
          first,
          {
            kind: 'record',
            action: { kind: 'start', target: 'launch' },
          },
          'origin',
        ),
      );
      // Let the take reserve the recorder before the rival Start arrives.
      yield* Effect.yieldNow;
      const rejected = yield* Effect.flip(
        requests.handle(
          second,
          {
            kind: 'record',
            action: { kind: 'start', target: 'launch' },
          },
          'other',
        ),
      );
      expect(rejected).toMatchObject({ _tag: 'Rejected' });
      expect(snapshot).toHaveBeenLastCalledWith({
        session: '/papers/first',
        target: 'launch',
      });

      expect(
        yield* requests.handle(
          second,
          { kind: 'record', action: { kind: 'stop' } },
          'other',
        ),
      ).toEqual({ kind: 'done' });
      expect(audio.transcribeRecording).not.toHaveBeenCalled();
      startup.resolve({ success: true });
      expect(yield* Fiber.join(started)).toEqual({
        kind: 'text',
        text: 'A conserved quantity.',
      });
      expect(audio.startRecording).toHaveBeenCalledTimes(1);
      expect(audio.transcribeRecording).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenLastCalledWith(null);

      const killed = yield* Deferred.make<void>();
      audio.killActiveRecording.mockImplementation(() =>
        Deferred.doneUnsafe(killed, Effect.void),
      );
      const nextStartup = pDefer<{ success: boolean }>();
      audio.startRecording.mockReturnValueOnce(nextStartup.promise);
      const nextTake = yield* Effect.forkChild(
        requests.handle(
          first,
          {
            kind: 'record',
            action: { kind: 'start', target: 'launch' },
          },
          'origin',
        ),
      );
      yield* Effect.yieldNow;
      requests.cancel(first, 'other');
      expect(snapshot).toHaveBeenLastCalledWith({
        session: '/papers/first',
        target: 'launch',
      });
      requests.cancel(first, 'origin');
      nextStartup.resolve({ success: true });
      const cancelled = yield* Effect.flip(Fiber.join(nextTake));
      expect(cancelled).toMatchObject({ _tag: 'Cancelled' });
      // The cancelled take's kill runs on the detached take fiber.
      yield* Deferred.await(killed);
      expect(audio.killActiveRecording).toHaveBeenCalledTimes(1);
      expect(audio.transcribeRecording).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenLastCalledWith(null);
      unsubscribe();
    }).pipe(Effect.provide(processStores)),
);

it.effect(
  'stops the recorder before reading the transcription credential',
  () =>
    Effect.gen(function* () {
      audio.startRecording.mockReset();
      audio.stopRecording.mockReset();
      audio.transcribeRecording.mockReset();
      audio.startRecording.mockResolvedValue({ success: true });
      audio.stopRecording.mockResolvedValue({
        success: true,
        recordingPath: '/papers/first/recordings/take.wav',
      });
      const requests = new HostDraftRequests();
      const session = { roots: { storage: '/papers/first' } } as SessionHandle;

      const take = yield* Effect.forkChild(
        requests.handle(
          session,
          { kind: 'record', action: { kind: 'start', target: 'launch' } },
          'origin',
        ),
      );
      // Let the take reserve the recorder before Stop arrives.
      yield* Effect.yieldNow;
      expect(
        yield* requests.handle(
          session,
          { kind: 'record', action: { kind: 'stop' } },
          'origin',
        ),
      ).toEqual({ kind: 'done' });

      expect(yield* Effect.flip(Fiber.join(take))).toMatchObject({
        _tag: 'Rejected',
        reason:
          'Missing API key for openai. Set a provider API key in settings.',
      });
      // Sox was terminated first: the failing read cannot leave it recording.
      expect(audio.stopRecording).toHaveBeenCalledTimes(1);
      expect(audio.transcribeRecording).not.toHaveBeenCalled();
    }).pipe(Effect.provide(storesWithoutCredential)),
);
