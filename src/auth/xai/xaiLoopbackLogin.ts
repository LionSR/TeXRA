/**
 * Loopback (browser) sign-in program for xAI Grok OAuth — the shared loopback
 * flow bound to the registered Grok callback constants.
 */

import { defineLoopbackLogin } from '../oauth/loopbackLogin';
import { XAI_CALLBACK_PATH, XAI_CALLBACK_PORT } from './xaiConstants';
import { type XaiSession } from './xaiSessionTypes';

export const loginWithLoopback = defineLoopbackLogin<XaiSession>({
  ports: [XAI_CALLBACK_PORT],
  callbackPath: XAI_CALLBACK_PATH,
  displayName: 'Grok',
});
