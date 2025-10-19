// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - media utilities
import {
  startRecording,
  stopRecordingAndTranscribe,
} from '@frontend/media/audio';

// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'RecordingManager';
logger.initialize(CHANNEL);

interface RecordingCommandOverrides {
  startRecording?: string;
  stopRecording?: string;
  recordingStarted?: string;
  recordingError?: string;
  transcription?: string;
}

export class RecordingManager {
  private readonly commands: Required<RecordingCommandOverrides>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    overrides: RecordingCommandOverrides = {},
  ) {
    this.commands = {
      startRecording:
        overrides.startRecording ?? MAIN_VIEW_COMMANDS.START_RECORDING,
      stopRecording:
        overrides.stopRecording ?? MAIN_VIEW_COMMANDS.STOP_RECORDING,
      recordingStarted:
        overrides.recordingStarted ?? MAIN_VIEW_COMMANDS.RECORDING_STARTED,
      recordingError:
        overrides.recordingError ?? MAIN_VIEW_COMMANDS.RECORDING_ERROR,
      transcription:
        overrides.transcription ??
        MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED,
    };
  }

  async start(webviewView: vscode.WebviewView): Promise<void> {
    try {
      const result = await startRecording(this.context);
      if (result.success) {
        webviewView.webview.postMessage({
          command: this.commands.recordingStarted,
        });
      } else if (result.error) {
        vscode.window.showErrorMessage(result.error);
        webviewView.webview.postMessage({
          command: this.commands.recordingError,
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
        command: this.commands.recordingError,
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
              command: this.commands.transcription,
              text: result.text,
            });
          } else if (result.error) {
            vscode.window.showErrorMessage(result.error);
            webviewView.webview.postMessage({
              command: this.commands.recordingError,
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
        command: this.commands.recordingError,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
