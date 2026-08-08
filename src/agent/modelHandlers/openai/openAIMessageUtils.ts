// Local imports
import type { FileLocation } from '@shared/schemas';
import { joinNonEmpty } from '@utils/text/stringUtils';
import type { MediaAttachmentContext } from '../support/mediaAttachmentPolicy';

/** Options for normalizing OpenAI-style chat messages. */
export interface NormalizeOpenAIMessageContentOptions {
  /** Merge consecutive messages that share the same role. */
  mergeConsecutiveRoles?: boolean;
  /** Convert array-based message content into newline-joined strings. */
  convertContentToString?: boolean;
}

/** Minimal structural view of a chat content part (text or media). */
type ChatContentPart = { type: string; text?: string };

type MessageLike = {
  role?: string;
  content?: string | ChatContentPart[] | null;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  /** Tracked so merging assistant messages preserves DeepSeek-style reasoning that must round-trip to the API. */
  reasoning_content?: unknown;
};

/** Type guard for text content items in message content arrays. */
function isTextContentItem(
  item: unknown,
): item is { type: string; text: string } {
  return (
    item !== null &&
    typeof item === 'object' &&
    (item as { type?: unknown }).type === 'text' &&
    typeof (item as { text?: unknown }).text === 'string'
  );
}

/** Join two strings with a newline; an empty operand passes the other through. */
function joinStringsWithNewline(a: string, b: string): string {
  if (a === '' || b === '') return a || b;
  return `${a}\n${b}`;
}

function mergeReasoningContent(
  previous: MessageLike,
  current: MessageLike,
): void {
  const prevReasoning = previous.reasoning_content;
  const currReasoning = current.reasoning_content;
  if (currReasoning == null) return;
  if (prevReasoning == null) {
    previous.reasoning_content = currReasoning;
    return;
  }
  if (typeof prevReasoning === 'string' && typeof currReasoning === 'string') {
    previous.reasoning_content = joinStringsWithNewline(
      prevReasoning,
      currReasoning,
    );
  }
}

function mergeMessageContent(
  previous: MessageLike,
  current: MessageLike,
): void {
  mergeReasoningContent(previous, current);

  const prevContent = previous.content;
  const currContent = current.content;

  // No previous content: use current
  if (prevContent == null) {
    previous.content = currContent;
    return;
  }

  // Note: Messages are shallow-copied before merging, so this must only
  // replace top-level fields and build new arrays — never mutate the
  // (shared) nested content items.

  // Both arrays: concatenate
  if (Array.isArray(prevContent) && Array.isArray(currContent)) {
    previous.content = [...prevContent, ...currContent];
    return;
  }

  // Both strings: join with newline (empty strings pass through unchanged)
  if (typeof prevContent === 'string' && typeof currContent === 'string') {
    previous.content = joinStringsWithNewline(prevContent, currContent);
    return;
  }

  // Previous array + current string: append non-empty string as text item
  if (Array.isArray(prevContent) && typeof currContent === 'string') {
    if (currContent.length > 0) {
      previous.content = [...prevContent, { type: 'text', text: currContent }];
    }
    return;
  }

  // Previous string/empty + current array: prepend non-empty string or use array
  if (Array.isArray(currContent)) {
    if (typeof prevContent === 'string' && prevContent.length > 0) {
      previous.content = [{ type: 'text', text: prevContent }, ...currContent];
    } else if (prevContent === '') {
      previous.content = currContent;
    }
  }
}

function canMergeMessages(
  previous: MessageLike,
  current: MessageLike,
): boolean {
  if (previous.role !== current.role) return false;

  return (
    previous.role !== 'tool' &&
    previous.tool_calls == null &&
    current.tool_calls == null &&
    previous.tool_call_id == null &&
    current.tool_call_id == null
  );
}

/**
 * Normalize OpenAI chat messages according to provided options.
 *
 * @param messages The original messages array.
 * @param options Normalization options controlling merging and content conversion.
 * @returns A normalized copy of the message array.
 */
export function normalizeOpenAIMessageContent<T extends MessageLike>(
  messages: T[],
  options?: NormalizeOpenAIMessageContentOptions,
): T[] {
  if (!Array.isArray(messages) || !messages.length || !options) {
    return messages;
  }

  const {
    mergeConsecutiveRoles = false,
    convertContentToString: asString = false,
  } = options;

  // Shallow per-message copies suffice: merging and string conversion only
  // replace top-level fields (content / reasoning_content) and content-array
  // containers. Nested content items are never mutated, so a structuredClone
  // of the whole history per request is wasted work.
  let working: T[] = messages.map((message) => {
    const copy = { ...message };
    if (Array.isArray(copy.content)) {
      copy.content = [...copy.content];
    }
    return copy;
  });

  if (mergeConsecutiveRoles) {
    const merged: T[] = [];

    for (const message of working) {
      const previous = merged.at(-1);
      if (!previous || !canMergeMessages(previous, message)) {
        merged.push(message);
        continue;
      }

      mergeMessageContent(previous, message);
    }

    working = merged;
  }

  if (asString) {
    for (const message of working) {
      if (Array.isArray(message.content)) {
        // Extract text from content array items and join with newlines
        message.content = message.content
          .filter(isTextContentItem)
          .map((item) => item.text)
          .join('\n');
      }
    }
  }

  return working;
}

/**
 * Prepend `text` to the last user message in a chat-shaped conversation.
 *
 * Chat providers (OpenAI, OpenRouter) model user content as either a plain
 * string or an array of typed parts; this mutates whichever shape is present
 * in place — merging into the first existing text part, or unshifting a new
 * one. A blank `text` or the absence of a user message is a no-op.
 */
export function prependTextToChatUserMessage<T extends MessageLike>(
  messages: T[],
  text: string,
): void {
  if (!text.trim()) return;

  const lastUserMsg = messages.findLast((m) => m.role === 'user');
  if (!lastUserMsg || !('content' in lastUserMsg)) return;

  const content = lastUserMsg.content;
  if (typeof content === 'string') {
    lastUserMsg.content = text + content;
  } else if (Array.isArray(content)) {
    const firstTextPart = content.find(isTextContentItem);
    if (firstTextPart) {
      firstTextPart.text = text + firstTextPart.text;
    } else {
      content.unshift({ type: 'text', text });
    }
  }
}

/**
 * Insert already-formatted media parts at the front of a user message.
 *
 * Operates on the specific message the caller already located and validated —
 * NOT a re-scan of the array — so media lands on that message even if the
 * conversation gained another user turn while async media formatting was in
 * flight. The caller owns provider-specific media formatting and the decision
 * to skip work when vision is unsupported or no user message exists; this
 * shares only the string-vs-array insertion so OpenAI and OpenRouter don't
 * diverge. A string body is promoted to a parts array with the media ahead of
 * the text.
 */
export function insertMediaIntoChatUserMessage(
  message: MessageLike,
  formattedMedia: readonly ChatContentPart[],
): void {
  const content = message.content;
  if (typeof content === 'string') {
    message.content = [...formattedMedia, { type: 'text', text: content }];
  } else if (Array.isArray(content)) {
    content.unshift(...formattedMedia);
  }
}

/** Capability flags `initializeChatMessages`/`createChatRoundMessages` need from the handler. */
interface ChatMessageRoutingCapabilities {
  supportsIntermDevMsgs: boolean;
  supportsVision: boolean;
  supportsNativeAudio: boolean;
}

/** Formats a round's media files into the provider's own content-part shape. */
type CreateMediaForRound = (
  mediaFiles: FileLocation[],
  context: MediaAttachmentContext,
) => Promise<readonly ChatContentPart[]>;

/**
 * Builds the initial message array for a chat-shaped provider (OpenAI,
 * OpenRouter): an optional system/developer-role prompt, then a user turn
 * carrying the prefix and any media, then the user request — routed to the
 * "system" role instead of "user" when the model requires intermediate
 * messages in that role (`supportsIntermDevMsgs`).
 */
export async function initializeChatMessages<T extends MessageLike>(
  userPrefix: string,
  userRequest: string,
  mediaFiles: FileLocation[] | undefined,
  systemPrompt: string | undefined,
  capabilities: ChatMessageRoutingCapabilities,
  createMediaForRound: CreateMediaForRound,
): Promise<T[]> {
  const messages: T[] = [];

  // Every runnable model accepts a system-role prompt. The only models that
  // ever needed the 'user'-role fallback were o1-mini / o1-preview, both
  // retired, so the system prompt always goes in the 'system' role now.
  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: [{ type: 'text', text: systemPrompt }],
    } as T);
  }

  // Create content list for the user message (only add non-empty prefix)
  const userMessageContent: ChatContentPart[] = [];
  if (userPrefix) {
    userMessageContent.push({ type: 'text', text: userPrefix });
  }

  // Add media if provided
  if (
    mediaFiles?.length &&
    (capabilities.supportsVision || capabilities.supportsNativeAudio)
  ) {
    const formattedMediaContent = await createMediaForRound(
      mediaFiles,
      'initial',
    );
    userMessageContent.push(...formattedMediaContent);
  }

  // Append content to last user message, or create new user message
  const lastMsg = messages.at(-1);
  if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
    lastMsg.content.push(...userMessageContent);
  } else {
    messages.push({ role: 'user', content: userMessageContent } as T);
  }

  // Add final user request
  const requestRole = capabilities.supportsIntermDevMsgs ? 'system' : 'user';
  const lastMessage = messages.at(-1);

  if (
    requestRole === 'user' &&
    lastMessage?.role === 'user' &&
    Array.isArray(lastMessage.content)
  ) {
    lastMessage.content.push({
      type: 'text',
      text: userRequest,
    });
  } else {
    messages.push({
      role: requestRole,
      content: [{ type: 'text', text: userRequest }],
    } as T);
  }

  return messages;
}

/** Adds user message content for subsequent rounds. */
export async function createChatRoundMessages<T extends MessageLike>(
  messages: T[],
  userMessage: string,
  mediaFiles: FileLocation[] | undefined,
  capabilities: Pick<
    ChatMessageRoutingCapabilities,
    'supportsVision' | 'supportsNativeAudio'
  >,
  createMediaForRound: CreateMediaForRound,
): Promise<T[]> {
  const roundContent: ChatContentPart[] = [];

  if (
    mediaFiles?.length &&
    (capabilities.supportsVision || capabilities.supportsNativeAudio)
  ) {
    const formattedMedia = await createMediaForRound(mediaFiles, 'followUp');
    roundContent.push(...formattedMedia);
  }
  // Only add text content if non-empty to avoid API "text content is empty" errors
  if (userMessage) {
    roundContent.push({ type: 'text', text: userMessage });
  }

  // Only push message if there's content (media or text)
  if (roundContent.length > 0) {
    messages.push({ role: 'user', content: roundContent } as T);
  }
  return messages;
}

/** Appends a plain user-turn message; used for user follow-up rounds. */
export function createChatUserFollowUpMessages<T extends MessageLike>(
  messages: T[],
  userMessage: string,
): T[] {
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: userMessage }],
  } as T);
  return messages;
}

/** Extracts the joined text content of a chat-shaped assistant message. */
export function extractChatAssistantText<T extends MessageLike>(
  message: T,
): string | undefined {
  if (message.role !== 'assistant') return undefined;
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return joinNonEmpty(
    content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          p.type === 'text' && typeof p.text === 'string',
      )
      .map((p) => p.text),
  );
}

/**
 * Appends a fresh continuation prompt, routed to "system" when the model
 * requires intermediate messages in that role.
 */
export function appendUserTextToChatMessages<T extends MessageLike>(
  messages: T[],
  text: string,
  supportsIntermDevMsgs: boolean,
): void {
  const role = supportsIntermDevMsgs ? 'system' : 'user';
  messages.push({ role, content: [{ type: 'text', text }] } as T);
}
