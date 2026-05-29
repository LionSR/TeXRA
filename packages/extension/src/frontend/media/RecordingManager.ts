// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - media utilities
import {
  startRecording,
  stopRecordingAndTranscribe,
} from '@frontend/media/audio';
import * as logger from '@logger/logUtils';

const CHANNEL = 'RecordingManager';
logger.initialize(CHANNEL);

export interface RecordingManagerConfig {
  recordingStartedCommand?: string;
  recordingStoppedCommand?: string;
  recordingErrorCommand?: string;
  transcriptionCommand?: string;
  buildRecordingMessage?: (input: {
    status: 'started' | 'stopped' | 'error';
    error?: string;
  }) => Record<string, unknown>;
  buildTranscriptionMessage?: (text: string) => Record<string, unknown> | null;
  progressTitle?: string;
}

export class RecordingManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly commandConfig: RecordingManagerConfig,
  ) {}

  private buildRecordingMessage(
    status: 'started' | 'stopped' | 'error',
    error?: string,
  ): Record<string, unknown> | null {
    if (this.commandConfig.buildRecordingMessage) {
      return this.commandConfig.buildRecordingMessage({ status, error });
    }

    const commandMap = {
      started: this.commandConfig.recordingStartedCommand,
      stopped: this.commandConfig.recordingStoppedCommand,
      error: this.commandConfig.recordingErrorCommand,
    };
    const command = commandMap[status];
    if (!command) return null;

    return error ? { command, error } : { command };
  }

  private buildTranscriptionMessage(
    text: string,
  ): Record<string, unknown> | null {
    if (this.commandConfig.buildTranscriptionMessage) {
      return this.commandConfig.buildTranscriptionMessage(text);
    }

    const command = this.commandConfig.transcriptionCommand;
    return command ? { command, text } : null;
  }

  private notifyError(webview: vscode.Webview, message: string): void {
    vscode.window.showErrorMessage(message);
    const payload = this.buildRecordingMessage('error', message);
    if (payload) webview.postMessage(payload);
  }

  async start(
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    try {
      const result = await startRecording(this.context);
      if (result.success) {
        const payload = this.buildRecordingMessage('started');
        if (payload) webviewView.webview.postMessage(payload);
      } else if (result.error) {
        this.notifyError(webviewView.webview, result.error);
      }
    } catch (error) {
      const errorMsg = toErrorMessage(error);
      logger.error(CHANNEL, `Error starting recording: ${errorMsg}`);
      this.notifyError(webviewView.webview, errorMsg);
    }
  }

  async stop(
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    let stopAcknowledged = false;
    const acknowledgeStop = (): void => {
      if (stopAcknowledged) return;
      stopAcknowledged = true;
      const payload = this.buildRecordingMessage('stopped');
      if (payload) webviewView.webview.postMessage(payload);
    };

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: this.commandConfig.progressTitle ?? 'Transcribing recording',
          cancellable: false,
        },
        async () => {
          const transcriptionPromise = stopRecordingAndTranscribe(this.context);
          acknowledgeStop();
          const result = await transcriptionPromise;
          if (result.success) {
            const payload = this.buildTranscriptionMessage(result.text);
            if (payload) webviewView.webview.postMessage(payload);
          } else if (result.error) {
            this.notifyError(webviewView.webview, result.error);
          }
        },
      );
    } catch (error) {
      const errorMsg = toErrorMessage(error);
      logger.error(CHANNEL, `Error stopping recording: ${errorMsg}`);
      this.notifyError(webviewView.webview, errorMsg);
      acknowledgeStop();
    }
  }
}
