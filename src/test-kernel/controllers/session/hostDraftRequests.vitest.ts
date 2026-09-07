// Third-party imports
import pDefer from 'p-defer';
import { expect, it, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import { effectRuntime } from '@platform/processRuntime';
import type { HostOutcome } from '@shared/session/sessionFrames';

const audio = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecordingAndTranscribe: vi.fn(),
  killActiveRecording: vi.fn(),
}));

vi.mock('@tools/media/audio', () => audio);
vi.mock('@agent/runtime/RunContext', () => ({
  runInSession: (_session: SessionHandle, run: () => unknown) => run(),
}));
vi.mock('@agent/runtime/textEnhancement', () => ({
  polishTextWithAI: vi.fn(),
}));

it('returns transcription to Start when another paper stops the process recorder', async () => {
  const startup = pDefer<{ success: boolean }>();
  audio.startRecording.mockReturnValue(startup.promise);
  audio.stopRecordingAndTranscribe.mockResolvedValue({
    success: true,
    text: 'A conserved quantity.',
  });
  const requests = new HostDraftRequests();
  // The request surface is Effect-typed; the test settles it on the process
  // runtime the fake host installs, as the host edge does.
  const handle = (
    ...args: Parameters<HostDraftRequests['handle']>
  ): Promise<HostOutcome> =>
    effectRuntime().runPromise(requests.handle(...args));
  const first = { roots: { storage: '/papers/first' } } as SessionHandle;
  const second = { roots: { storage: '/papers/second' } } as SessionHandle;
  const snapshot = vi.fn();
  const unsubscribe = requests.subscribe(snapshot);

  const started = handle(
    first,
    {
      kind: 'record',
      action: { kind: 'start', target: 'launch' },
    },
    'origin',
  );
  await expect(
    handle(
      second,
      {
        kind: 'record',
        action: { kind: 'start', target: 'launch' },
      },
      'other',
    ),
  ).rejects.toMatchObject({ _tag: 'Rejected' });
  expect(snapshot).toHaveBeenLastCalledWith({
    session: '/papers/first',
    target: 'launch',
  });

  await expect(
    handle(second, { kind: 'record', action: { kind: 'stop' } }, 'other'),
  ).resolves.toEqual({ kind: 'done' });
  expect(audio.stopRecordingAndTranscribe).not.toHaveBeenCalled();
  startup.resolve({ success: true });
  await expect(started).resolves.toEqual({
    kind: 'text',
    text: 'A conserved quantity.',
  });
  expect(audio.startRecording).toHaveBeenCalledTimes(1);
  expect(audio.stopRecordingAndTranscribe).toHaveBeenCalledTimes(1);
  expect(snapshot).toHaveBeenLastCalledWith(null);

  const nextStartup = pDefer<{ success: boolean }>();
  audio.startRecording.mockReturnValueOnce(nextStartup.promise);
  const nextTake = handle(
    first,
    {
      kind: 'record',
      action: { kind: 'start', target: 'launch' },
    },
    'origin',
  );
  const cancelled = expect(nextTake).rejects.toMatchObject({
    _tag: 'Cancelled',
  });
  requests.cancel(first, 'other');
  expect(snapshot).toHaveBeenLastCalledWith({
    session: '/papers/first',
    target: 'launch',
  });
  requests.cancel(first, 'origin');
  nextStartup.resolve({ success: true });
  await cancelled;
  await vi.waitFor(() =>
    expect(audio.killActiveRecording).toHaveBeenCalledTimes(1),
  );
  expect(audio.stopRecordingAndTranscribe).toHaveBeenCalledTimes(1);
  expect(snapshot).toHaveBeenLastCalledWith(null);
  unsubscribe();
});
