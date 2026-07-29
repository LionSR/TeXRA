// Local imports
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';

// Local file imports
import {
  isGemini3Model,
  resolveGeminiThinkingLevel,
  supportsGoogleFileUploads,
} from './googleHandlerShared';

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

  protected supportsFileUploads(): boolean {
    return supportsGoogleFileUploads(this.capabilities);
  }

  protected isGemini3Model(): boolean {
    return isGemini3Model(this.config.fullName);
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

  protected getThinkingLevel(): TLevel | undefined {
    const { levels, labels } = this.thinkingLevelConfig;
    return resolveGeminiThinkingLevel<TLevel>({
      reasoningEffort: this.capabilities.reasoningEffort,
      isGemini3: this.isGemini3Model(),
      isPro: this.config.fullName.includes('-pro'),
      logger: this.logger,
      levels,
      labels,
    });
  }
}
