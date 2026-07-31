// Third-party imports
import { ReasoningEffort } from 'llm-zoo';

// Local imports
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type {
  ModelCredentialSelection,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import type { FileLocation } from '@shared/schemas';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';
import { getShortDisplayPath } from '@utils/files';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import {
  type GoogleClientCache,
  type GoogleMediaSource,
  resolveGoogleClient,
  uploadGoogleMediaEntries,
} from './googleHandlerShared';
import { tagGoogleSdkError } from './googleSdkError';
import type { GoogleGenAI } from '@google/genai';

/**
 * Shared base for the two Google handlers ({@link ModelHandlerGoogleGenAI} chat
 * SDK path and {@link ModelHandlerGoogleInteractions} Interactions path). Both
 * speak the same `GoogleGenAI` SDK, so the client cache, the media-attachment
 * pipeline, the capability getters, and the batched tool-result contract live
 * here; only the wire shapes differ, and the subclass supplies those through
 * {@link buildMedia} / {@link textMedia} / {@link thinkingLevelConfig}.
 *
 * Generic over the same wire types as {@link ModelHandler} (`M`/`U`/`T`/`Resp`/
 * `Media`) plus `TLevel` — the SDK's `thinking_level` representation (the
 * `@google/genai` enum for chat, the lowercase Interactions string literals for
 * Interactions).
 */
export abstract class GoogleModelHandlerBase<
  M extends ProviderMessage = ProviderMessage,
  U = unknown,
  T extends SdkToolCall = SdkToolCall,
  Resp = unknown,
  Media = unknown,
  TLevel = unknown,
> extends ModelHandler<M, U, T, GoogleGenAI, Resp, Media> {
  /**
   * Inline-vs-uploaded media threshold for the Google File API; 20 MiB for both
   * handlers.
   */
  private static readonly INLINE_MEDIA_LIMIT_BYTES = 20 * 1024 * 1024;

  private googleClient: GoogleClientCache | null = null;

  /** SDK surface label used in client-setup debug logs. */
  protected abstract get sdkLabel(): string;

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

  async getClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<GoogleGenAI> {
    const credential = await this.resolveClientCredential(selection);
    return resolveGoogleClient({
      sdkLabel: this.sdkLabel,
      credential,
      logger: this.logger,
      cached: this.googleClient,
      setCached: (cache) => {
        this.googleClient = cache;
      },
      rememberRoute: (client, route, credentialSecret) =>
        this.rememberClientCredentialRoute(client, route, credentialSecret),
    });
  }

  override async refreshClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<GoogleGenAI> {
    this.googleClient = null;
    return this.getClient(selection);
  }

  protected override get sdkErrorTagger() {
    return tagGoogleSdkError;
  }

  override get supportsForcedToolChoice(): boolean {
    return true;
  }

  /**
   * Google passes the system prompt per-call (`systemInstruction` for chat,
   * `system_instruction` for Interactions) rather than storing it in `messages`
   * (see each handler's `initializeMessages`) — the round flow must resupply it
   * on every invocation.
   */
  override get requiresPerCallSystemPrompt(): boolean {
    return true;
  }

  /**
   * Gemini carries thought signatures across parallel function calls, which must
   * be preserved by batching the results into a single follow-up: the handler
   * rebuilds the model-generated turn (thought signatures + every function call)
   * ahead of the results, in the order the model emitted them. The tool-use flow
   * only records the assistant turn through the follow-up methods (see
   * `ToolUseDispatchNode`), so splitting parallel calls across separate turns
   * would lose the signature and reference a call absent from the transcript.
   * Unconditional (not gated on `capabilities.supportsReasoning`) — see the base
   * getter's doc comment (#7101 triage).
   */
  override get requiresBatchedParallelToolResults(): boolean {
    return true;
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

  /** Build the provider's media block from inline base64 data or a File API uri. */
  protected abstract buildMedia(
    source: GoogleMediaSource,
    mimeType: string,
  ): Media;

  /** Build the provider's text block (used for media labels and plain text). */
  protected abstract textMedia(text: string): Media;

  protected override async createMediaMessage(
    mediaFiles: FileLocation[],
  ): Promise<Media[]> {
    if (!mediaFiles?.length || !this.supportsFileUploads()) {
      return [];
    }

    const { entries, results } =
      await this.mediaProcessor.loadEntries(mediaFiles);
    this.mediaProcessor.logResults(results);

    if (entries.length === 0) {
      return [];
    }

    return this.uploadMediaEntries(entries);
  }

  /** Media blocks for the entries (inline when small enough, uploaded otherwise). */
  protected async uploadMediaEntries(entries: MediaEntry[]): Promise<Media[]> {
    const insertedEntries: MediaEntry[] = [];
    const media = await uploadGoogleMediaEntries<Media>(entries, {
      getClient: () => this.getClient(),
      inlineLimit: this.getInlineUploadLimitBytes(),
      logger: this.logger,
      buildMedia: (source, mimeType) => this.buildMedia(source, mimeType),
      onInsertedEntry: (entry) => insertedEntries.push(entry),
    });
    this.setCreatedMediaEntriesForAttachmentLog(insertedEntries);
    return media;
  }

  /** Labelled media for a round, or empty when there is nothing to attach. */
  protected async buildLabelledMedia(
    mediaFiles: FileLocation[] | undefined,
    context: 'initial' | 'followUp',
  ): Promise<Media[]> {
    if (!mediaFiles?.length || !this.supportsFileUploads()) {
      return [];
    }

    const media = await this.createMediaForRound(mediaFiles, context);
    if (media.length === 0) {
      return [];
    }

    const label = mediaFiles.map((loc) => getShortDisplayPath(loc)).join(', ');
    const verb = context === 'initial' ? 'Attached' : 'Processing';
    return [
      this.textMedia(
        `\n${verb} ${pluralize(mediaFiles.length, 'file')}: ${label}`,
      ),
      ...media,
    ];
  }

  /**
   * Follow-up for MULTIPLE parallel tool calls, in model-emitted order. The
   * single-call path below is batched-of-one, so this is the one place each
   * handler reconstructs the assistant turn and its tool results.
   */
  abstract createBatchedToolUseFollowUpMessages(
    entries: Array<{
      call: T;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<M[]>;

  async createToolUseFollowUpMessages(
    _client: GoogleGenAI | undefined,
    call: T,
    result: ToolResult,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<M[]> {
    if (!call.callId) {
      throw new Error('Function call id is required for follow-up messages');
    }

    return this.createBatchedToolUseFollowUpMessages(
      [{ call, result, attachments }],
      workspaceState,
      text,
    );
  }
}
