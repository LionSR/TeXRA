// Third-party imports
import * as assert from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - utils
import { WorkspaceFS } from '@utils/files/workspaceFS';

describe('WorkspaceFS Test Suite', () => {
  it('delete should be idempotent - not throw when file does not exist', async () => {
    // Test that deleting a non-existent file doesn't throw
    const nonExistentPath = 'this-file-definitely-does-not-exist-12345.txt';

    // This should not throw an error
    await assert.doesNotReject(
      async () => await WorkspaceFS.delete(nonExistentPath),
      'delete() should not throw when file does not exist',
    );
  });
});
