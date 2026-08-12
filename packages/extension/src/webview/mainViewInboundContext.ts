import * as vscode from 'vscode';

import { RecordingManager } from '@frontend/media/RecordingManager';
import * as logger from '@logger/logUtils';

import type { DiffManager } from './managers/DiffManager';
import type { FileManager } from './managers/FileManager';
import type { InstructionManager } from './managers/InstructionManager';

/**
 * The slice-visible face of {@link MainViewMessageHandler}. Inbound command
 * slices live in ./slices/ and receive this narrow, bound context instead of
 * reaching into the handler class, keeping the class's private surface private
 * while letting each slice own a domain of commands.
 */
export interface MainViewInboundHost {
  readonly viewName: string;
  readonly channel: string;
  readonly logger: typeof logger;
  readonly context: vscode.ExtensionContext;
  /**
   * Recompute and re-push the onboarding funnel (owned by
   * MainViewProvider). Called on webview ready and after welcome-card
   * actions that change the funnel inputs (skip, API-key entry).
   */
  readonly refreshOnboardingFunnel?: () => Promise<void>;
  readonly fileManager: FileManager;
  readonly diffManager: DiffManager;
  readonly instructionManager: InstructionManager;
  readonly recordingManager: RecordingManager;

  runWithActiveView<T>(fn: (view: vscode.WebviewView) => T): T | undefined;
  getActiveView(): vscode.WebviewView | undefined;
  postToActiveView(message: unknown): void;
  handleWebviewReady(): Promise<void>;
  handleThemeRequest(): void;
  handleDebugModeRequest(): void;
  refreshAfterCredentialChange(): Promise<void>;
}
