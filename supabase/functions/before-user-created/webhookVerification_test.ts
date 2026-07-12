// Standard library imports
import { strict as assert } from 'node:assert';

// Local imports
import { createWebhookVerifier } from './webhookVerification.ts';

Deno.test('requires a configured hook secret', () => {
  for (const secret of [undefined, '']) {
    assert.throws(
      () => createWebhookVerifier(secret),
      /BEFORE_USER_CREATED_HOOK_SECRET is required/,
    );
  }
});

Deno.test('rejects unusable hook secrets', () => {
  for (const secret of ['not-base64', 'v1,whsec_']) {
    assert.throws(
      () => createWebhookVerifier(secret),
      /BEFORE_USER_CREATED_HOOK_SECRET is unusable/,
    );
  }
});

Deno.test('creates a verifier for the Supabase secret format', () => {
  const verifier = createWebhookVerifier('v1,whsec_dGVzdC1ob29rLXNlY3JldA==');
  const body = '{}';
  const id = 'test-message';
  const timestamp = new Date();
  const signature = verifier.sign(id, timestamp, body);

  assert.deepEqual(
    verifier.verify(body, {
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'webhook-signature': signature,
    }),
    {},
  );
});
