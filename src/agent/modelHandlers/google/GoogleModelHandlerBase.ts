// Third-party imports
import { ReasoningEffort } from 'llm-zoo';

// Local imports
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';

/**
 * Shared base for the two Google handlers ({@link ModelHandlerGoogleGenAI} chat
 * SDK path and {@link ModelHandlerGoogleInteractions} Interactions path). Hosts
 * the capability getters that are identical or differ only by a per-SDK
 * thinking-level literal map.
 *
 * Generic over the same wire types as {@link ModelHandler} (`M`/`U`/`T`/`C`/
 * `Resp`/`Media`) plus `TLevel` — the SDK's `thinking_level` representation
 * (the `@google/genai` enum for chat, the lowercase Interactions string literals
 * for Interactions), supplied by the subclass through {@link thinkingLevelConfig}
 * (mirrors how `googleUsage` parameterizes `GoogleUsageFields`).
 */
export abstract class GoogleModelHandlerBase<
  M extends ProviderMessage = ProviderMessage,
  U = unknown,
  T extends SdkToolCall = SdkToolCall,
  C = unknown,
  Resp = unknown,
  Media = unknown,
  TLevel = unknown,
> extends ModelHandler<M, U, T, C, Resp, Media> {
  /**
   * Inline-vs-uploaded media threshold for the Google File API; 20 MiB for both
   * handlers.
   */
  private static readonly INLINE_MEDIA_LIMIT_BYTES = 20 * 1024 * 1024;

  /** Whether the model can accept file attachments (image/video or native audio). */
  protected supportsFileUploads(): boolean {
    return (
      this.capabilities.supportsVision || this.capabilities.supportsNativeAudio
    );
  }

  /** Whether the model is a Gemini 3 variant (different thinking/media rules). */
  protected isGemini3Model(): boolean {
    return /^gemini-3[\.\-]/.test(this.config.fullName);
  }

  protected getInlineUploadLimitBytes(): number {
    return GoogleModelHandlerBase.INLINE_MEDIA_LIMIT_BYTES;
  }

  /**
   * Per-handler `thinking_level` literals: the SDK enum values (chat) or the
   * Interactions lowercase string literals, plus the human-readable labels used
   * in log messages. Supplied by the subclass so the shared
   * {@link getThinkingLevel} skeleton stays provider-agnostic.
   */
  protected abstract get thinkingLevelConfig(): {
    levels: { low: TLevel; medium: TLevel; high: TLevel };
    labels: { low: string; medium: string; high: string };
  };

  /**
   * Map the model's reasoning effort to a Gemini `thinking_level`.
   *
   * Returns `levels.low` (not `undefined`) for `NONE` so the API does not fall
   * back to its default medium/high — that would defeat the user's intent.
   * Gemini tops out at HIGH thinking, so xhigh/max both map to it; Gemini 3 Pro
   * only supports low/high, so MEDIUM falls back to HIGH for Pro.
   */
  protected getThinkingLevel(): TLevel | undefined {
    const { levels, labels } = this.thinkingLevelConfig;
    const isGemini3 = this.isGemini3Model();

    switch (this.capabilities.reasoningEffort) {
      case ReasoningEffort.NONE:
        if (isGemini3) {
          this.logger.warn(
            `Gemini 3 models can't fully disable thinking. Using thinking_level '${labels.low}'.`,
          );
        }
        return levels.low;

      case ReasoningEffort.LOW:
        return levels.low;

      case ReasoningEffort.MEDIUM:
        if (isGemini3 && this.config.fullName.includes('-pro')) {
          this.logger.debug(
            `Gemini 3 Pro does not support ${labels.medium} thinking level. Using ${labels.high}.`,
          );
          return levels.high;
        }
        return levels.medium;

      case ReasoningEffort.HIGH:
      case ReasoningEffort.XHIGH:
      case ReasoningEffort.MAX:
        return levels.high;

      default:
        return undefined;
    }
  }
}
