import { describe, expect, it } from 'vitest';

import { ToolError } from '@shared/schemas/toolResult';
import { assertNoParentTraversal } from '@tools/pathResolution';

describe('assertNoParentTraversal', () => {
  it.each(['../x', 'a/../../x'])('rejects %s', (targetPath) => {
    expect(() => assertNoParentTraversal(targetPath)).toThrow(ToolError);
    expect(() => assertNoParentTraversal(targetPath)).toThrow(
      `path must not contain '..': ${targetPath}`,
    );
  });

  it.each(['a/b', 'a..b'])('accepts %s', (targetPath) => {
    expect(() => assertNoParentTraversal(targetPath)).not.toThrow();
  });
});
