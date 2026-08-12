import {
  createProgressHostInteractions,
  type ProgressHostInteractions,
  type ProgressHostInteractionsOptions,
} from '@controllers/progressView/backend/progressHostInteractions';

interface DesktopHostInteractionsOptions extends ProgressHostInteractionsOptions {
  showInfoMessage(message: string): Promise<void> | void;
}

/**
 * The shared progress-view host port plus the Electron shell's notification
 * surface, which the runtime reaches through `session.interactions`.
 */
export function createDesktopHostInteractions(
  options: DesktopHostInteractionsOptions,
): ProgressHostInteractions {
  return {
    ...createProgressHostInteractions(options),
    showInfoMessage: options.showInfoMessage,
  };
}
