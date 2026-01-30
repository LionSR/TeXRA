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

export type RecordingCommandMap = RecordingManagerConfig;

export function wireRecordingFlow(
  context: vscode.ExtensionContext,
  commands: RecordingCommandMap,
): RecordingManager {
  return new RecordingManager(context, commands);
}

export class RecordingManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly commandConfig: RecordingManagerConfig,
  ) {}

  private notifyError(webview: vscode.Webview, message: string): void {
    vscode.window.showErrorMessage(message);
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
