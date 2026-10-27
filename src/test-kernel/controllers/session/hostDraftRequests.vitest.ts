// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, FileSystem, Layer } from 'effect';
import { expect, vi } from 'vitest';

// Local imports
import { RouteRetries } from '@agent/runtime/run/invocation';
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';
import { AppState } from '@platform/interfaces';
import { StorageFs } from '@platform/rootedFs';
import { Secrets } from '@platform/secrets';
import { UsageLog } from '@shared/usageLog';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { HostDraftRequests } from '@texra/controllers/session/hostDraftRequests';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';
import type { WorkspaceRoots } from '@texra-ai/harness';

// The recorder module answers in Effects, so every double returns one: a
// bare `vi.fn()` would hand the take fiber `undefined` to yield.
const audio = vi.hoisted(() => ({
  startRecording: vi.fn(),
  validateRecordingFile: vi.fn(),
  transcribeRecording: vi.fn(),
  recordingsDir: vi.fn(
    (roots: { storage: string }) => `${roots.storage}/recordings`,
  ),
}));

vi.mock('@texra/tools/media/audio', () => audio);

/** A recorder double: the take's path once `startup` settles, a sox whose
 *  exit is `exitCode`, and `onStop` run when the take's scope stops it. */
const recorder = (
  startup: Effect.Effect<string>,
  exitCode: Effect.Effect<number> = Effect.never,
  onStop: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const path = yield* startup;
    yield* Effect.addFinalizer(() => onStop);
    return { path, handle: { exitCode } };
  });

/** The same pair with no saved OpenAI key, so the take's credential read
 *  fails after the recorder has already been stopped. */
const storesWithoutCredential = Layer.mergeAll(
  Secrets.layer(new FakeSecrets()),
  AppState.layer(new FakeStateStore()),
  FileSystem.layerNoop({}),
  // The pasted-image arm's storage view; this suite exercises the recorder,
  // so nothing here reads it.
  Layer.succeed(StorageFs)({} as RootedFileSystem),
  testHttpClientLayer,
  UsageLog.disabled,
  // The helper call's route gate, as `processLayer` serves it.
  Layer.effect(RouteRetries, ModelRetryGate.make),
  scriptedSpawnerLayer(() => ({})).layer,
);

it.effect(
  'stops the recorder before reading the transcription credential',
  () =>
    Effect.gen(function* () {
      audio.startRecording.mockReset();
      audio.validateRecordingFile.mockReset();
      audio.transcribeRecording.mockReset();
      audio.startRecording.mockReturnValue(
        recorder(Effect.succeed('/papers/first/recordings/take.wav')),
      );
      audio.validateRecordingFile.mockImplementation((path: string) =>
        Effect.succeed(path),
      );
      const requests = new HostDraftRequests();
      const session = {
        storage: '/papers/first',
        ...makeFakeSettingsStores().stores,
      } as WorkspaceRoots;

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
      expect(audio.validateRecordingFile).toHaveBeenCalledTimes(1);
      expect(audio.transcribeRecording).not.toHaveBeenCalled();
    }).pipe(Effect.provide(storesWithoutCredential)),
);
