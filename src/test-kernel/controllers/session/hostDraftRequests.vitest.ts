// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import pDefer from 'p-defer';
import { expect, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import { apiKeySecretName } from '@model/apiProviders';
import { AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';

const audio = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecordingAndTranscribe: vi.fn(),
  killActiveRecording: vi.fn(),
}));

vi.mock('@tools/media/audio', () => audio);
vi.mock('@agent/runtime/textEnhancement', () => ({
  polishTextWithAI: vi.fn(),
}));

// The process stores `handle` resolves its models against: the polish model,
// and the OpenAI credential the take binds its transcription under, which is
// why the credential store carries a key.
const processStores = Layer.mergeAll(
  Secrets.layer(
    () => new FakeSecrets({ [apiKeySecretName('openai')]: 'sk-test' }),
  ),
  AppState.layer(() => new FakeStateStore()),
);

it.effect(
  'returns transcription to Start when another paper stops the process recorder',
  () =>
    Effect.gen(function* () {
      const startup = pDefer<{ success: boolean }>();
      audio.startRecording.mockReturnValue(startup.promise);
      audio.stopRecordingAndTranscribe.mockResolvedValue({
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
      expect(audio.stopRecordingAndTranscribe).not.toHaveBeenCalled();
      startup.resolve({ success: true });
      expect(yield* Fiber.join(started)).toEqual({
        kind: 'text',
        text: 'A conserved quantity.',
      });
      expect(audio.startRecording).toHaveBeenCalledTimes(1);
      expect(audio.stopRecordingAndTranscribe).toHaveBeenCalledTimes(1);
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
      expect(audio.stopRecordingAndTranscribe).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenLastCalledWith(null);
      unsubscribe();
    }).pipe(Effect.provide(processStores)),
);
