// Third-party imports
import * as assert from 'assert';

// Local imports - utils
import { getMimeType } from '@utils/files';

describe('mimeUtils Test Suite', () => {
  it('applies audio override for known extensions from file paths', () => {
    assert.strictEqual(getMimeType('/tmp/clip.opus'), 'audio/opus');
    assert.strictEqual(getMimeType('C:\\tmp\\clip.l16'), 'audio/l16');
  });

  it('applies audio override for bare extension values', () => {
    assert.strictEqual(getMimeType('opus'), 'audio/opus');
    assert.strictEqual(getMimeType('.mulaw'), 'audio/mulaw');
  });

  it('does not apply audio override to extensionless file paths', () => {
    assert.strictEqual(getMimeType('/tmp/opus'), null);
    assert.strictEqual(getMimeType('C:\\tmp\\mulaw'), null);
  });
});
