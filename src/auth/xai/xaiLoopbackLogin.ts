/**
 * Loopback (browser) sign-in for xAI Grok OAuth — thin wrapper around the
 * shared {@link loginWithOAuthLoopback}.
 */
import {
  loginWithOAuthLoopback,
  type LoopbackOAuthCoordinator,
} from '../oauth/loopbackLogin';
import { XAI_CALLBACK_PATH, XAI_CALLBACK_PORT } from './xaiConstants';
import { type XaiSession } from './xaiSessionTypes';

export interface XaiLoopbackLoginOptions {
  coordinator: LoopbackOAuthCoordinator<XaiSession>;
  openBrowser: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function loginWithLoopback(
  options: XaiLoopbackLoginOptions,
): Promise<XaiSession> {
  return loginWithOAuthLoopback({
    coordinator: options.coordinator,
    openBrowser: options.openBrowser,
    signal: options.signal,
    ports: [XAI_CALLBACK_PORT],
    callbackPath: XAI_CALLBACK_PATH,
    displayName: 'Grok',
  });
}
