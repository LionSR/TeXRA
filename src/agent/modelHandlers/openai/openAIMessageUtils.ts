/** Options for normalizing OpenAI-style chat messages. */
export interface NormalizeOpenAIMessageContentOptions {
  /** Merge consecutive messages that share the same role. */
  mergeConsecutiveRoles?: boolean;
  /** Convert array-based message content into newline-joined strings. */
  convertContentToString?: boolean;
}

type MessageLike = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  /** Tracked so merging assistant messages preserves DeepSeek-style reasoning that must round-trip to the API. */
  reasoning_content?: unknown;
};

type ContentArray = Array<Record<string, unknown>>;

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
    if (prevReasoning === '' || currReasoning === '') {
      previous.reasoning_content = prevReasoning || currReasoning;
    } else {
      previous.reasoning_content = `${prevReasoning}\n${currReasoning}`;
    }
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

  // Note: Messages are already deep-cloned before merging, so we can safely
  // spread arrays without additional structuredClone calls.

  // Both arrays: concatenate
  if (Array.isArray(prevContent) && Array.isArray(currContent)) {
    previous.content = [...prevContent, ...currContent];
    return;
  }

  // Both strings: join with newline (empty strings pass through unchanged)
  if (typeof prevContent === 'string' && typeof currContent === 'string') {
    if (prevContent === '' || currContent === '') {
      previous.content = prevContent || currContent;
    } else {
      previous.content = `${prevContent}\n${currContent}`;
    }
    return;
  }

  // Previous array + current string: append non-empty string as text item
  if (Array.isArray(prevContent) && typeof currContent === 'string') {
    if (currContent.length > 0) {
      previous.content = [
        ...(prevContent as ContentArray),
        { type: 'text', text: currContent },
      ];
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

  let working: T[] = messages.map((message) => structuredClone(message));

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
        message.content = (message.content as Array<unknown>)
          .filter(isTextContentItem)
          .map((item) => item.text)
          .join('\n');
      }
    }
  }

  return working;
}
