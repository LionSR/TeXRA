// Node imports
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

const SOURCE_PATH =
  'packages/extension/src/frontend/auth/SupabaseAuthProvider.ts';

describe('Supabase auth model refresh', () => {
  it('invalidates model availability before publishing session changes', () => {
    const source = readFileSync(path.join(process.cwd(), SOURCE_PATH), 'utf8');

    const loginRefresh = source.indexOf(
      'invalidateModelOptionsCache();',
      source.indexOf('private async storeSession'),
    );
    const loginEvent = source.indexOf(
      'this._onDidChangeSessions.fire',
      loginRefresh,
    );
    const signOutRefresh = source.indexOf(
      'invalidateModelOptionsCache();',
      source.indexOf('async removeSession'),
    );
    const signOutEvent = source.indexOf(
      'this._onDidChangeSessions.fire',
      signOutRefresh,
    );

    expect(loginRefresh).toBeGreaterThan(-1);
    expect(loginEvent).toBeGreaterThan(loginRefresh);
    expect(signOutRefresh).toBeGreaterThan(-1);
    expect(signOutEvent).toBeGreaterThan(signOutRefresh);
  });
});
