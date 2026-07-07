import { afterEach, describe, expect, it } from 'vitest';

import { installPlatform } from '@test/support/setupPlatform';
import { checkToolInstalled } from '@utils/system/toolUtils';

afterEach(async () => {
  await installPlatform();
});

describe('checkToolInstalled', () => {
  it('reports an unknown tool as not installed even when toolMissingHandler is absent (optional Platform port)', async () => {
    await installPlatform({}, { toolMissingHandler: undefined });

    await expect(
      checkToolInstalled('definitely-not-a-real-tool-xyz', true),
    ).resolves.toBe(false);
  });
});
