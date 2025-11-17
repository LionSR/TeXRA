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

  async start(webviewView: vscode.WebviewView): Promise<void> {
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
      vscode.window.showErrorMessage(
        `Error starting recording: ${toErrorMessage(error)}`,
      );
      logger.error(CHANNEL, `Error in start: ${toErrorMessage(error)}`);
      webviewView.webview.postMessage({
        command: this.commandConfig.recordingErrorCommand,
        error: toErrorMessage(error),
      });
    }
  }

  async stop(webviewView: vscode.WebviewView): Promise<void> {
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
      vscode.window.showErrorMessage(
        `Error stopping recording: ${toErrorMessage(error)}`,
      );
      logger.error(CHANNEL, `Error in stop: ${toErrorMessage(error)}`);
      webviewView.webview.postMessage({
        command: this.commandConfig.recordingErrorCommand,
        error: toErrorMessage(error),
      });
      acknowledgeStop();
    }
  }
}
