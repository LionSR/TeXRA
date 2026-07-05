/**
 * Composed handler registry for MainView backend messages.
 *
 * Handlers are organized into domain-specific slices under ./slices/ (same
 * shape as progressView/frontend/messageDispatcher.ts), keyed by
 * MAIN_VIEW_COMMANDS. `MainApp.handleMessage` routes raw messages through
 * `dispatchMainView(raw, mainViewMessageHandlers, onError)`.
 */

// Local imports - shared schemas
import type { MainViewHandlerRegistry } from '@shared/schemas';

// Slice imports
import { bannerHandlers } from './slices/bannerSlice';
import { catalogHandlers } from './slices/catalogSlice';
import { chatHandlers } from './slices/chatSlice';
import { documentHandlers } from './slices/documentSlice';
import { onboardingHandlers } from './slices/onboardingSlice';
import { sessionHandlers } from './slices/sessionSlice';

export const mainViewMessageHandlers: MainViewHandlerRegistry = {
  ...catalogHandlers,
  ...sessionHandlers,
  ...documentHandlers,
  ...chatHandlers,
  ...bannerHandlers,
  ...onboardingHandlers,
};
