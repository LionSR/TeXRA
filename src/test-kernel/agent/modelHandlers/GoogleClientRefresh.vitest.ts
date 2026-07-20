import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

// Local imports
import { withModelClient } from '@agent/core/flows/CycleServices';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Third-party imports
import type { GoogleGenAI } from '@google/genai';

const GOOGLE_TEST_CONFIG = Object.freeze({
  name: 'google-client-refresh',
  label: 'Google client refresh',
  fullName: 'gemini-3-pro-test',
  shortName: 'gemini-3-pro-test',
  provider: ModelProvider.GOOGLE,
  contextWindow: 4096,
  capabilities: Object.freeze({ supportsVision: true }),
});

type GoogleHandlerWithCache = {
  googleClient: GoogleGenAI | null;
};

function setCachedClient(
  handler: ModelHandlerGoogleGenAI | ModelHandlerGoogleInteractions,
  client: GoogleGenAI,
): void {
  (handler as unknown as GoogleHandlerWithCache).googleClient = client;
}

class GoogleGenAIRefreshProbe extends ModelHandlerGoogleGenAI {
  readonly replacement = {} as GoogleGenAI;
  cacheSeenByGetClient: GoogleGenAI | null | undefined;

  override async getClient(): Promise<GoogleGenAI> {
    this.cacheSeenByGetClient = (
      this as unknown as GoogleHandlerWithCache
    ).googleClient;
    return this.replacement;
  }
}

class GoogleInteractionsRefreshProbe extends ModelHandlerGoogleInteractions {
  readonly replacement = {} as GoogleGenAI;
  cacheSeenByGetClient: GoogleGenAI | null | undefined;

  override async getClient(): Promise<GoogleGenAI> {
    this.cacheSeenByGetClient = (
      this as unknown as GoogleHandlerWithCache
    ).googleClient;
    return this.replacement;
  }
}

describe('Google client refresh', () => {
  it('drops the native Google client cached under the previous key', async () => {
    const handler = new GoogleGenAIRefreshProbe(
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
    );
    setCachedClient(handler, {} as GoogleGenAI);

    await expect(handler.refreshClient()).resolves.toBe(handler.replacement);
    expect(handler.cacheSeenByGetClient).toBeNull();
  });

  it('drops the Google Interactions client cached under the previous key', async () => {
    const handler = new GoogleInteractionsRefreshProbe(
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
    );
    setCachedClient(handler, {} as GoogleGenAI);

    await expect(handler.refreshClient()).resolves.toBe(handler.replacement);
    expect(handler.cacheSeenByGetClient).toBeNull();
  });

  it('does not publish a replacement client after its preparation is cancelled', async () => {
    const initial = {} as GoogleGenAI;
    const replacement = {} as GoogleGenAI;
    let finishRefresh: (() => void) | undefined;
    const handler = new GoogleGenAIRefreshProbe(
      buildTestModelConfig(GOOGLE_TEST_CONFIG),
    );
    handler.getClient = async () => initial;
    handler.refreshClient = async () => {
      await new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      return replacement;
    };
    const services = await withModelClient({}, handler);
    const controller = new AbortController();

    const refresh = services.refreshClient?.(controller.signal);
    controller.abort(new Error('Retry preparation cancelled.'));
    finishRefresh?.();

    await expect(refresh).rejects.toThrow('Retry preparation cancelled.');
    expect(services.client).toBe(initial);
  });
});
