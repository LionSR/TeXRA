// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - Supabase relay
import {
  FREE_TIER_REQUEST_BODY_LIMIT_BYTES,
  checkRequestBodySizeLimit,
  formatRequestBytes,
  readRequestBodyWithinSizeLimit,
} from '../../../supabase/functions/relay/requestLimits';

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('relay free-tier request size limits', () => {
  it('rejects free-tier request bodies over the byte cap', () => {
    assert.deepEqual(checkRequestBodySizeLimit('abc', 3), {
      allowed: true,
      limitBytes: 3,
      requestBytes: 3,
    });
    assert.deepEqual(checkRequestBodySizeLimit('abcd', 3), {
      allowed: false,
      limitBytes: 3,
      requestBytes: 4,
    });
  });

  it('counts UTF-8 bytes rather than JavaScript string length', () => {
    const result = checkRequestBodySizeLimit('€', 2);

    assert.equal(result.allowed, false);
    assert.equal(result.requestBytes, 3);
  });

  it('uses existing byte lengths for binary request bodies', () => {
    const result = checkRequestBodySizeLimit(new Uint8Array([0, 255, 1]), 2);

    assert.equal(result.allowed, false);
    assert.equal(result.requestBytes, 3);
  });

  it('reads accepted request streams without changing bytes', async () => {
    const result = await readRequestBodyWithinSizeLimit(
      byteStream([new Uint8Array([0, 255]), new Uint8Array([1])]),
      3,
    );

    if (!result.allowed) assert.fail('expected body under the cap');
    assert.deepEqual([...result.body], [0, 255, 1]);
    assert.equal(result.requestBytes, 3);
  });

  it('stops reading request streams after the cap is exceeded', async () => {
    const result = await readRequestBodyWithinSizeLimit(
      byteStream([new Uint8Array([0, 1]), new Uint8Array([2, 3])]),
      3,
    );

    assert.equal(result.allowed, false);
    assert.equal(result.body, null);
    assert.equal(result.requestBytes, 4);
  });

  it('uses a loose default limit for normal research requests', () => {
    assert.equal(FREE_TIER_REQUEST_BODY_LIMIT_BYTES, 2 * 1024 * 1024);
    assert.equal(
      formatRequestBytes(FREE_TIER_REQUEST_BODY_LIMIT_BYTES),
      '2 MiB',
    );
  });
});
