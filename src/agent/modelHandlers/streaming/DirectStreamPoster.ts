/**
 * Direct stream poster for bypassing EventBus.
 *
 * This module provides a lightweight mechanism for posting streaming content
 * directly to the webview, reducing the typical 5-hop path to 2-3 hops:
 *
 * Before: Handler → Logger.createStream → EventBus → ProgressEventHandler → WebviewUpdater → webview
 * After:  Handler → DirectStreamPoster → webview
 *
 * Usage:
 * ```typescript
 * // In ProgressViewProvider or similar:
 * const poster = new DirectStreamPoster(webviewUpdater, streamTabId);
 * modelHandler.setStreamPoster(poster);
 * ```
 */

import { randomUUID } from 'crypto';

import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { LogMessageData, LogStream } from '@logger/LogTypes';
import type { MessageType } from '@logger/messageTypes';

/**
 * Interface for posting streaming content directly to the webview.
 * Returns LogStream for compatibility with AgentLogger.createStream().
 */
export interface StreamPoster {
  /**
   * Create a new stream for the given message type.
   * Returns a LogStream with append/finalize methods.
   */
  createStream(type: MessageType, options?: { groupId?: string }): LogStream;
}

/**
 * Function signature for posting messages to webview.
 * Uses LogMessageData for type compatibility with WebviewUpdater.
 */
export interface WebviewMessagePoster {
  appendLogMessage(stream: StreamTabId, logMessage: LogMessageData): void;
  updateLogMessage(stream: StreamTabId, logMessage: LogMessageData): void;
  isAvailable(): boolean;
}

/**
 * Implementation of StreamPoster that posts directly to webview.
 */
export class DirectStreamPoster implements StreamPoster {
  constructor(
    private readonly poster: WebviewMessagePoster,
    private readonly streamTabId: StreamTabId,
    private readonly resolveGroupId: () => string | undefined,
  ) {}

  createStream(
    type: MessageType,
    options?: { groupId?: string },
  ): LogStream {
    const id = randomUUID();
    const groupId = options?.groupId ?? this.resolveGroupId();
    let buffer = '';
    let isFirstUpdate = true;
    let isFinalized = false;
    let createdAt = 0;

    return {
      append: (text: string) => {
        if (!text || isFinalized) return;

        buffer += text;

        if (!this.poster.isAvailable()) return;

        if (isFirstUpdate) {
          createdAt = Date.now();
          this.poster.appendLogMessage(this.streamTabId, {
            id,
            text: buffer,
            level: 'info',
            timestamp: createdAt,
            groupId,
            messageType: type,
          });
          isFirstUpdate = false;
        } else {
          this.poster.updateLogMessage(this.streamTabId, {
            id,
            text: buffer,
            level: 'info',
            timestamp: createdAt,
            groupId,
            messageType: type,
          });
        }
      },

      finalize: (finalText?: string): string => {
        if (isFinalized) {
          return buffer;
        }
        isFinalized = true;

        if (typeof finalText === 'string') {
          buffer = finalText;
        }

        if (!this.poster.isAvailable()) {
          return buffer;
        }

        if (isFirstUpdate) {
          createdAt = Date.now();
          this.poster.appendLogMessage(this.streamTabId, {
            id,
            text: buffer,
            level: 'info',
            timestamp: createdAt,
            groupId,
            messageType: type,
          });
          isFirstUpdate = false;
        } else {
          this.poster.updateLogMessage(this.streamTabId, {
            id,
            text: buffer,
            level: 'info',
            timestamp: createdAt,
            groupId,
            messageType: type,
          });
        }

        return buffer;
      },
    };
  }
}
