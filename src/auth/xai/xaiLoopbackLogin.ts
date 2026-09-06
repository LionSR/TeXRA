/**
 * Loopback (browser) sign-in program for xAI Grok OAuth — thin wrapper around the
 * shared {@link loginWithOAuthLoopback}.
 */

import {
  loginWithOAuthLoopback,
  type LoopbackOAuthCoordinator,
} from '../oauth/loopbackLogin';
import { XAI_CALLBACK_PATH, XAI_CALLBACK_PORT } from './xaiConstants';
import { type XaiSession } from './xaiSessionTypes';
import type { Effect } from 'effect';
import type { HttpClient } from 'effect/unstable/http';

export interface XaiLoopbackLoginOptions {
  coordinator: LoopbackOAuthCoordinator<XaiSession>;
  openBrowser: (url: string) => void | Promise<void>;
}

export function loginWithLoopback(
  options: XaiLoopbackLoginOptions,
): Effect.Effect<XaiSession, unknown, HttpClient.HttpClient> {
  return loginWithOAuthLoopback({
    coordinator: options.coordinator,
    openBrowser: options.openBrowser,
    ports: [XAI_CALLBACK_PORT],
    callbackPath: XAI_CALLBACK_PATH,
    displayName: 'Grok',
  });
}
