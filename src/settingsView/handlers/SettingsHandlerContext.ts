/**
 * Shared context for domain-specific settings handler delegates.
 *
 * Provides the minimal surface that handler implementations need
 * from the main SettingsViewMessageHandler.
 */
import type * as vscode from 'vscode';

export interface SettingsHandlerContext {
  readonly channel: string;
  readonly logger: {
    warn: (channel: string, msg: string) => void;
    error: (channel: string, msg: string, data?: unknown) => void;
    debug: (channel: string, msg: string, data?: { data?: unknown }) => void;
  };
  /** Run a callback with the active webview, if available. */
  withActiveWebview: (
    fn: (w: vscode.Webview) => Promise<void>,
  ) => Promise<void>;
}
