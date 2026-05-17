/**
 * Shared context for domain-specific settings handler delegates.
 *
 * Provides the minimal surface that handler implementations need
 * from the main SettingsViewMessageHandler.
 */
import type { LogUtilsOptions } from '@logger/logUtils';

import type * as vscode from 'vscode';

export interface SettingsHandlerContext {
  readonly channel: string;
  readonly logger: {
    warn: (channel: string, msg: string, options?: LogUtilsOptions) => void;
    error: (channel: string, msg: string, options?: LogUtilsOptions) => void;
    debug: (channel: string, msg: string, options?: LogUtilsOptions) => void;
  };
  /** VS Code extension context, used to resolve bundled resources. */
  readonly extensionContext: vscode.ExtensionContext;
  /** Run a callback with the active webview, if available. */
  withActiveWebview: (
    fn: (w: vscode.Webview) => Promise<void>,
  ) => Promise<void>;
}
