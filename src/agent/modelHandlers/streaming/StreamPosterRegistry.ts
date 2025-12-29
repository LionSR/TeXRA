/**
 * Global registry for direct stream posters.
 *
 * This module provides a singleton registry that allows ProgressViewProvider
 * to register its WebviewUpdater, which ModelHandler can then use to create
 * direct stream posters that bypass EventBus.
 *
 * Architecture:
 * 1. ProgressViewProvider calls `registerWebviewPoster(webviewPoster)` on init
 * 2. AgentExecutionContext or BaseAgent calls `createPoster(streamId)` when setting up
 * 3. DirectStreamPoster posts directly to webview (2-3 hops vs 5+ hops via EventBus)
 */

import type { StreamTabId } from '@agent/types/IdentifierTypes';

import {
  DirectStreamPoster,
  type StreamPoster,
  type WebviewMessagePoster,
} from './DirectStreamPoster';

/**
 * Singleton registry for stream poster factory.
 */
class StreamPosterRegistryImpl {
  private webviewPoster: WebviewMessagePoster | null = null;
  private groupIdResolver: ((streamId: StreamTabId) => string | undefined) | null = null;
  private posterCache: Map<StreamTabId, StreamPoster> = new Map();

  /**
   * Register the webview poster and group ID resolver.
   * Called by ProgressViewProvider when webview is created.
   */
  register(
    poster: WebviewMessagePoster,
    groupIdResolver: (streamId: StreamTabId) => string | undefined,
  ): void {
    this.webviewPoster = poster;
    this.groupIdResolver = groupIdResolver;
  }

  /**
   * Unregister the webview poster.
   * Called by ProgressViewProvider on dispose.
   */
  unregister(): void {
    this.webviewPoster = null;
    this.groupIdResolver = null;
    this.posterCache.clear();
  }

  /**
   * Create a stream poster for the given stream tab ID.
   * Returns cached poster if available, creates new one otherwise.
   * Returns null if no webview poster is registered.
   */
  createPoster(streamTabId: StreamTabId): StreamPoster | null {
    if (!this.webviewPoster || !this.groupIdResolver) {
      return null;
    }

    // Return cached poster if available
    const cached = this.posterCache.get(streamTabId);
    if (cached) {
      return cached;
    }

    // Create and cache new poster
    const poster = this.webviewPoster;
    const resolver = this.groupIdResolver;

    const newPoster = new DirectStreamPoster(
      poster,
      streamTabId,
      () => resolver(streamTabId),
    );

    this.posterCache.set(streamTabId, newPoster);
    return newPoster;
  }

  /**
   * Check if a poster is available.
   */
  isAvailable(): boolean {
    return this.webviewPoster !== null;
  }
}

/**
 * Global stream poster registry instance.
 */
export const streamPosterRegistry = new StreamPosterRegistryImpl();
