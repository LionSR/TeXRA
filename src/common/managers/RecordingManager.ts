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
  recordingStartedCommand: string;
  recordingStoppedCommand: string;
  recordingErrorCommand: string;
  transcriptionCommand: string;
  progressTitle?: string;
}

export class RecordingManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly commandConfig: RecordingManagerConfig,
  ) {}

  private handleError(
    webview: vscode.Webview,
    error: unknown,
    operation: string,
  ): void {
    const message = toErrorMessage(error);
    vscode.window.showErrorMessage(`Error ${operation}: ${message}`);
    logger.error(CHANNEL, `Error in ${operation}: ${message}`);
    webview.postMessage({
      command: this.commandConfig.recordingErrorCommand,
      error: message,
    });
  }

  async start(
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    try {
      const result = await startRecording(this.context);
      if (result.success) {
        webviewView.webview.postMessage({
          command: this.commandConfig.recordingStartedCommand,
        });
      } else if (result.error) {
        vscode.window.showErrorMessage(result.error);
        webviewView.webview.postMessage({
          command: this.commandConfig.recordingErrorCommand,
          error: result.error,
        });
      }
    } catch (error) {
      this.handleError(webviewView.webview, error, 'starting recording');
    }
  }

  async stop(
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    let stopAcknowledged = false;
    const acknowledgeStop = () => {
      if (stopAcknowledged) {
        return;
      }
      stopAcknowledged = true;
      webviewView.webview.postMessage({
        command: this.commandConfig.recordingStoppedCommand,
      });
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
            webviewView.webview.postMessage({
              command: this.commandConfig.transcriptionCommand,
              text: result.text,
            });
          } else if (result.error) {
            vscode.window.showErrorMessage(result.error);
            webviewView.webview.postMessage({
              command: this.commandConfig.recordingErrorCommand,
              error: result.error,
            });
          }
        },
      );
    } catch (error) {
      this.handleError(webviewView.webview, error, 'stopping recording');
      acknowledgeStop();
    }
  }
}
