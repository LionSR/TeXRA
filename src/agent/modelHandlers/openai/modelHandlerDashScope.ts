// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';

/**
 * Handler for DashScope Qwen models using OpenAI-compatible API.
 * usageProvider and toolCallProvider inherit from base class via config.provider.
 *
 * Note: Thinking blocks are handled by the base OpenAI handler.
 * createMediaContent is inherited from ModelHandlerOpenAI.
 */
export class ModelHandlerDashScope extends ModelHandlerOpenAI {
  /** DashScope requires content to be converted to strings. */
  protected override readonly convertContentToString = true;
}
