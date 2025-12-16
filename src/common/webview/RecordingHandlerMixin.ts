/**
 * RecordingHandlerMixin - Shared recording handler factory
 *
 * Eliminates duplicate RecordingManager setup and handler definitions
 * across MainViewMessageHandler and ProgressViewMessageHandler.
 */
import * as vscode from 'vscode';

import {
  RecordingManager,
  type RecordingManagerConfig,
} from '@common/managers/RecordingManager';

import type { MessageHandler } from './BaseViewMessageHandler';

/**
 * Configuration for recording handler creation.
 * Extends RecordingManagerConfig with the command keys used in handler mapping.
 */
export interface RecordingHandlerConfig extends RecordingManagerConfig {
  /** Command key for starting recording (used as handler map key) */
  startCommand: string;
  /** Command key for stopping recording (used as handler map key) */
  stopCommand: string;
}

/**
 * Result of creating recording handlers.
 */
export interface RecordingHandlerResult {
  /** The RecordingManager instance for use in the handler class */
  manager: RecordingManager;
  /** Handler map entries to spread into createHandlers() */
  handlers: Record<string, MessageHandler<vscode.WebviewView>>;
}

/**
 * Creates a RecordingManager and associated handlers for a webview.
 *
 * Usage:
 * ```typescript
 * const { manager, handlers } = createRecordingHandlers(context, {
 *   startCommand: MAIN_VIEW_COMMANDS.START_RECORDING,
 *   stopCommand: MAIN_VIEW_COMMANDS.STOP_RECORDING,
 *   recordingStartedCommand: MAIN_VIEW_COMMANDS.RECORDING_STARTED,
 *   recordingStoppedCommand: MAIN_VIEW_COMMANDS.RECORDING_STOPPED,
 *   recordingErrorCommand: MAIN_VIEW_COMMANDS.RECORDING_ERROR,
 *   transcriptionCommand: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED,
 *   progressTitle: 'Transcribing instruction',
 * });
 * this.recordingManager = manager;
 * // In createHandlers(): ...handlers
 * ```
 *
 * @param context - VS Code extension context
 * @param config - Recording configuration including command mappings
 * @returns Object with manager instance and handler map entries
 */
export function createRecordingHandlers(
  context: vscode.ExtensionContext,
  config: RecordingHandlerConfig,
): RecordingHandlerResult {
  const manager = new RecordingManager(context, {
    recordingStartedCommand: config.recordingStartedCommand,
    recordingStoppedCommand: config.recordingStoppedCommand,
    recordingErrorCommand: config.recordingErrorCommand,
    transcriptionCommand: config.transcriptionCommand,
    progressTitle: config.progressTitle,
  });

  const handlers: Record<string, MessageHandler<vscode.WebviewView>> = {
    [config.startCommand]: async (_message, webviewView) =>
      manager.start(webviewView),
    [config.stopCommand]: async (_message, webviewView) =>
      manager.stop(webviewView),
  };

  return { manager, handlers };
}
