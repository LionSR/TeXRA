// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';

/**
 * The resource-path catalog is a single source of truth: the tool description
 * and the "Unknown path" error both render from it. These tests guard the
 * drift the catalog was introduced to prevent — the error string had
 * previously lost the `/{path}` sub-reads that the description documented, so
 * the two surfaces could describe different sets of valid paths.
 */
describe('ExecutionsTool resource-path catalog', () => {
  setupPlatform({ workspacePath: '/workspace' });

  // Entries that used to appear only in the description, not the error.
  const SUB_PATH_READS = [
    '/executions/{id}/files/{path}',
    '/executions/{id}/workspace-files/{path}',
  ];

  it('lists every resource path in the tool description', () => {
    const { description } = new ExecutionsTool().definition;
    for (const resourcePath of SUB_PATH_READS) {
      expect(description).toContain(resourcePath);
    }
  });

  it('renders the unknown-path error from the same catalog', async () => {
    const result = await new ExecutionsTool().call({
      path: '/executions/abc123abc123/bogus',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Unknown path:');
    // Now shared with the description, so they render on both surfaces.
    for (const resourcePath of SUB_PATH_READS) {
      expect(result.error).toContain(resourcePath);
    }
  });
});
