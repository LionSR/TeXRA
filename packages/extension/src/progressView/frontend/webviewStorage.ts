/**
 * Shared webview storage singleton for the progress view.
 *
 * All components in the progress view frontend MUST use this shared instance
 * rather than calling `createWebviewStorage(hostBridge)` independently. Multiple
 * independent instances each maintain their own cache, so writes from one
 * instance can silently overwrite changes made by another.
 */
import { createWebviewStorage } from '@shared/state';
import { hostBridge } from '@shared/hostBridge';

export const webviewStorage = createWebviewStorage(hostBridge);
