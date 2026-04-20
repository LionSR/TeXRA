// Node.js built-in imports
import * as assert from 'assert';

// Local imports - tools
import { findExternalToolDef } from '@tools/externalToolDefs';

describe('external tool definitions', () => {
  it('keeps Zotero visible as a user-toggleable tool group', () => {
    const zotero = findExternalToolDef('zotero');

    assert.ok(zotero, 'Zotero tool definition should exist');
    assert.strictEqual(zotero.toggleable, true);
    assert.deepStrictEqual(zotero.tools, [
      'zotero_collections',
      'zotero_search',
      'zotero_add',
      'zotero_export',
    ]);
  });
});
