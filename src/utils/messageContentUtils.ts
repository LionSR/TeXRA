// No third-party imports needed - this module is provider-agnostic

/**
 * Utility functions for manipulating message content in a type-safe way
 * across different AI provider formats (OpenAI, Anthropic, Google GenAI, etc.)
 */

// Common types for unified handling
export type MessageContent = string | any[] | null | undefined;
export type ContentPart = {
  type?: string;
  text?: string;
  [key: string]: any;
};

// Type guards
export function isArrayContent(content: any): content is any[] {
  return Array.isArray(content);
}

export function isStringContent(content: any): content is string {
  return typeof content === 'string';
}

// Helper for creating text content parts
export function createTextPart(text: string) {
  return {
    type: 'text' as const,
    text: text,
  };
}

// Helper for safely accessing message at index
export function getMessageAt(messages: any[], index: number): any | null {
  if (index < 0) {
    const actualIndex = messages.length + index;
    return actualIndex >= 0 ? messages[actualIndex] : null;
  }
  return index < messages.length ? messages[index] : null;
}

// ===== UNIFIED PROVIDER-AGNOSTIC FUNCTIONS =====

/**
 * Provider configuration for content manipulation
 */
export interface ProviderConfig {
  // How to create a text content part
  createTextPart: (text: string) => any;
  // How to extract text from a content part
  extractText?: (part: any) => string | undefined;
  // Whether to include type field in text parts
  includeTypeInTextPart?: boolean;
}

// Provider configurations
export const PROVIDERS = {
  openai: {
    createTextPart: (text: string) => ({ type: 'text' as const, text }),
    extractText: (part: any) => part.text,
    includeTypeInTextPart: true,
  },
  anthropic: {
    createTextPart: (text: string) => ({
      type: 'text' as const,
      text,
      citations: null,
    }),
    extractText: (part: any) => part.text,
    includeTypeInTextPart: true,
  },
  google: {
    createTextPart: (text: string) => ({ text }),
    extractText: (part: any) => part.text,
    includeTypeInTextPart: false,
  },
} as const;

/**
 * Append text to the last message in a provider-agnostic way
 */
export function appendToLastMessage(
  messages: any[],
  text: string,
  provider: keyof typeof PROVIDERS = 'openai',
): boolean {
  const lastMessage = messages.at(-1);
  if (!lastMessage) return false;

  const config = PROVIDERS[provider];
  const newPart = config.createTextPart(text);

  if (isArrayContent(lastMessage.content)) {
    lastMessage.content.push(newPart);
    return true;
  } else if (isStringContent(lastMessage.content)) {
    // Convert string to array format
    const existingPart = config.createTextPart(lastMessage.content);
    lastMessage.content = [existingPart, newPart];
    return true;
  } else if (
    lastMessage.content === null ||
    lastMessage.content === undefined
  ) {
    lastMessage.content = [newPart];
    return true;
  }
  return false;
}

/**
 * Set the content of the last message
 */
export function setLastMessageContent(
  messages: any[],
  text: string,
  provider: keyof typeof PROVIDERS = 'openai',
): boolean {
  const lastMessage = messages.at(-1);
  if (!lastMessage) return false;

  const config = PROVIDERS[provider];

  if (isArrayContent(lastMessage.content)) {
    // Find and update the last text part
    for (let i = lastMessage.content.length - 1; i >= 0; i--) {
      const part = lastMessage.content[i];
      if (part && part.text !== undefined) {
        part.text = text;
        return true;
      }
    }
    // If no text part found, add one
    lastMessage.content.push(config.createTextPart(text));
    return true;
  } else {
    // For string content, just replace it
    lastMessage.content = text;
    return true;
  }
}

/**
 * Get the text content of the last message
 */
export function getLastMessageText(
  messages: any[],
  provider: keyof typeof PROVIDERS = 'openai',
): string | null {
  const lastMessage = messages.at(-1);
  if (!lastMessage) return null;

  const config = PROVIDERS[provider];

  if (isStringContent(lastMessage.content)) {
    return lastMessage.content;
  } else if (isArrayContent(lastMessage.content)) {
    // Find the last text part
    for (let i = lastMessage.content.length - 1; i >= 0; i--) {
      const part = lastMessage.content[i];
      if (part && config.extractText) {
        const text = config.extractText(part);
        if (text !== undefined) return text;
      }
    }
  }
  return null;
}

/**
 * Append content part (more flexible than just text)
 */
export function appendContentToLastMessage(
  messages: any[],
  content: any,
  provider: keyof typeof PROVIDERS = 'openai',
): boolean {
  const lastMessage = messages.at(-1);
  if (!lastMessage) return false;

  if (isArrayContent(lastMessage.content)) {
    lastMessage.content.push(content);
    return true;
  } else if (isStringContent(lastMessage.content)) {
    const config = PROVIDERS[provider];
    const existingPart = config.createTextPart(lastMessage.content);
    lastMessage.content = [existingPart, content];
    return true;
  } else if (
    lastMessage.content === null ||
    lastMessage.content === undefined
  ) {
    lastMessage.content = [content];
    return true;
  }
  return false;
}

/**
 * Find and update the last text part in a message
 */
export function updateLastTextPart(
  message: any,
  updater: (text: string) => string,
  provider: keyof typeof PROVIDERS = 'openai',
): boolean {
  if (!message) return false;

  const config = PROVIDERS[provider];

  if (isStringContent(message.content)) {
    message.content = updater(message.content);
    return true;
  } else if (isArrayContent(message.content)) {
    // Find and update the last text part
    for (let i = message.content.length - 1; i >= 0; i--) {
      const part = message.content[i];
      if (part && config.extractText) {
        const text = config.extractText(part);
        if (text !== undefined) {
          part.text = updater(text);
          return true;
        }
      }
    }
  }
  return false;
}
