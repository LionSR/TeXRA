import * as vscode from 'vscode';

import type { ViewSliceHost } from '@common/webview';
import type { RecordingManager } from '@frontend/media/RecordingManager';

import type { DiffManager } from './managers/DiffManager';
import type { FileManager } from './managers/FileManager';
import type { InstructionManager } from './managers/InstructionManager';

/**
 * The slice-visible face of {@link MainViewMessageHandler}. Extends the
 * shared {@link ViewSliceHost} with main-view managers and the view-wrapper
 * accessor recording needs. Inbound command slices live in ./slices/ and
 * receive this instead of reaching into the handler class.
 */
export interface MainViewInboundHost extends ViewSliceHost {
  readonly viewName: string;
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
  handleWebviewReady(): Promise<void>;
  handleThemeRequest(): void;
  handleDebugModeRequest(): void;
  refreshAfterCredentialChange(): Promise<void>;
}
