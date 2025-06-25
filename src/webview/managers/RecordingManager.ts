// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import {
  startRecording,
  stopRecordingAndTranscribe,
} from '@frontend/media/audio';

const CHANNEL = 'RecordingManager';
logger.initialize(CHANNEL);

export class RecordingManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async start(webviewView: vscode.WebviewView): Promise<void> {
    try {
      const result = await startRecording(this.context);
      if (result.success) {
        webviewView.webview.postMessage({ command: 'recordingStarted' });
      } else if (result.error) {
        vscode.window.showErrorMessage(result.error);
        webviewView.webview.postMessage({
          command: 'recordingError',
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
        command: 'recordingError',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async stop(webviewView: vscode.WebviewView): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Transcribing instruction',
          cancellable: false,
        },
        async () => {
          const result = await stopRecordingAndTranscribe(this.context);
          if (result.success) {
            webviewView.webview.postMessage({
              command: 'instructionTextTranscribed',
              text: result.text,
            });
          } else if (result.error) {
            vscode.window.showErrorMessage(result.error);
            webviewView.webview.postMessage({
              command: 'recordingError',
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
        command: 'recordingError',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
