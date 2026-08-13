import { describe, expect, it } from 'vitest';

import { noopTrace } from '@agent/trace';
import {
  type GoogleClientCache,
  resolveGoogleClient,
} from '@agent/modelHandlers/google/googleHandlerShared';

describe('Google client credential cache', () => {
  it('reuses only a client built from the same credential snapshot', async () => {
    let cache: GoogleClientCache | null = null;
    const resolve = (apiKey: string, baseUrl: string | null) =>
      resolveGoogleClient({
        sdkLabel: 'test',
        credential: { apiKey, baseUrl, route: 'api-key' },
        logger: noopTrace,
        cached: cache,
        setCached: (next) => {
          cache = next;
        },
        rememberRoute: (client) => client,
      });

    const original = await resolve('old-key', null);
    expect(await resolve('old-key', null)).toBe(original);

    const replacement = await resolve('new-key', 'https://google.example/v1');
    expect(replacement).not.toBe(original);
    expect(await resolve('new-key', 'https://google.example/v1')).toBe(
      replacement,
    );
  });
});
