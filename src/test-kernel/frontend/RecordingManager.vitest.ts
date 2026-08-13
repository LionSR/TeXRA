// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecordingAndTranscribe: vi.fn(),
  showLoggedMessage: vi.fn(),
  withProgress: vi.fn(),
}));

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  window: { withProgress: mocks.withProgress },
}));

vi.mock('@tools/media/audio', () => ({
  startRecording: mocks.startRecording,
  stopRecordingAndTranscribe: mocks.stopRecordingAndTranscribe,
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedMessage: mocks.showLoggedMessage,
}));

vi.mock('@logger/logUtils', () => ({
  error: vi.fn(),
  initialize: vi.fn(),
}));

// Local imports - recording manager
const { RecordingManager } = await import('@frontend/media/RecordingManager');

describe('RecordingManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withProgress.mockImplementation((_options, task) => task());
  });

  it('uses one complete message protocol for recording and transcription', async () => {
    mocks.startRecording.mockResolvedValue({ success: true });
    mocks.stopRecordingAndTranscribe.mockResolvedValue({
      success: true,
      text: 'transcribed text',
    });
    const postMessage = vi.fn();
    const view = { webview: { postMessage } } as unknown as vscode.WebviewView;
    const manager = new RecordingManager({
      buildRecordingMessage: (message) => ({
        command: 'recording',
        ...message,
      }),
      buildTranscriptionMessage: (text) => ({
        command: 'transcription',
        text,
      }),
      progressTitle: 'Transcribing test recording',
    });

    await manager.start(view);
    await manager.stop(view);

    expect(mocks.withProgress).toHaveBeenCalledWith(
      {
        location: 15,
        title: 'Transcribing test recording',
        cancellable: false,
      },
      expect.any(Function),
    );
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { command: 'recording', status: 'started' },
      { command: 'recording', status: 'stopped' },
      { command: 'transcription', text: 'transcribed text' },
    ]);
  });
});
