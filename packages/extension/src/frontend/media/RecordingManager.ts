// Third-party imports
import * as vscode from 'vscode';

// Local imports - media utilities
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { createLog } from '@logger/logUtils';
import { startRecording, stopRecordingAndTranscribe } from '@tools/media/audio';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'RecordingManager';
const log = createLog(CHANNEL);

type RecordingMessageInput =
  { status: 'started' | 'stopped' } | { status: 'error'; error: string };

interface RecordingManagerConfig {
  buildRecordingMessage: (
    input: RecordingMessageInput,
  ) => Record<string, unknown>;
  buildTranscriptionMessage: (text: string) => Record<string, unknown>;
  progressTitle: string;
}

export class RecordingManager {
  constructor(private readonly commandConfig: RecordingManagerConfig) {}

  private notifyError(webview: vscode.Webview, message: string): void {
    void showLoggedMessage(CHANNEL, message);
    webview.postMessage(
      this.commandConfig.buildRecordingMessage({
        status: 'error',
        error: message,
      }),
    );
  }

  async start(
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    try {
      const result = await startRecording();
      if (result.success) {
        webviewView.webview.postMessage(
          this.commandConfig.buildRecordingMessage({ status: 'started' }),
        );
      } else if (result.error) {
        this.notifyError(webviewView.webview, result.error);
      }
    } catch (error) {
      const errorMsg = toErrorMessage(error);
      log.error(`Error starting recording: ${errorMsg}`);
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
      webviewView.webview.postMessage(
        this.commandConfig.buildRecordingMessage({ status: 'stopped' }),
      );
    };

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: this.commandConfig.progressTitle,
          cancellable: false,
        },
        async () => {
          const transcriptionPromise = stopRecordingAndTranscribe();
          acknowledgeStop();
          const result = await transcriptionPromise;
          if (result.success) {
            webviewView.webview.postMessage(
              this.commandConfig.buildTranscriptionMessage(result.text),
            );
          } else if (result.error) {
            this.notifyError(webviewView.webview, result.error);
          }
        },
      );
    } catch (error) {
      const errorMsg = toErrorMessage(error);
      log.error(`Error stopping recording: ${errorMsg}`);
      this.notifyError(webviewView.webview, errorMsg);
      acknowledgeStop();
    }
  }
}
