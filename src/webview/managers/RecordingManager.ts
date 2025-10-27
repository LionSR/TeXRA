// Third-party imports
import * as vscode from 'vscode';

// Local imports - media utilities
import {
  startRecording,
  stopRecordingAndTranscribe,
} from '@frontend/media/audio';

// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'RecordingManager';
logger.initialize(CHANNEL);

export interface RecordingManagerConfig {
  recordingStartedCommand: string;
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
        `Error starting recording: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      logger.error(
        CHANNEL,
        `Error in start: ${error instanceof Error ? error.message : String(error)}`,
      );
      webviewView.webview.postMessage({
        command: this.commandConfig.recordingErrorCommand,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async stop(webviewView: vscode.WebviewView): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: this.commandConfig.progressTitle ?? 'Transcribing recording',
          cancellable: false,
        },
        async () => {
          const result = await stopRecordingAndTranscribe(this.context);
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
        `Error stopping recording: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      logger.error(
        CHANNEL,
        `Error in stop: ${error instanceof Error ? error.message : String(error)}`,
      );
      webviewView.webview.postMessage({
        command: this.commandConfig.recordingErrorCommand,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
