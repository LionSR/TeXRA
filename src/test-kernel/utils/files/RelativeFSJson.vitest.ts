// Third-party imports

// Third-party imports
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';

// Local imports - test support
import { createFakePlatform } from '@test/support/FakePlatform';

// Local imports - utils
import { RelativeFS } from '@utils/files/relativeFS';

const BASE_DIR = path.join(os.tmpdir(), 'texra-relativefs-json-tests');

class TestRelativeFS extends RelativeFS {
  protected static override getBasePath(): string {
    return BASE_DIR;
  }
}

describe('RelativeFS JSON helpers', () => {
  beforeAll(async () => {
    // RelativeFS goes through the platform filesystem; back it with the real
    // node filesystem since this suite writes to a real temp directory.
    const [{ initPlatform }, { nodeFilesystem }] = await Promise.all([
      import('@platform/platform'),
      import('@platform/defaults/nodeFilesystem'),
    ]);
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));

    await fs
      .rm(BASE_DIR, { recursive: true, force: true })
      .catch(() => undefined);
    await fs.mkdir(BASE_DIR, { recursive: true });
  });

  beforeEach(async () => {
    // Ensure each test starts with a clean directory
    await fs
      .rm(BASE_DIR, { recursive: true, force: true })
      .catch(() => undefined);
    await fs.mkdir(BASE_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs
      .rm(BASE_DIR, { recursive: true, force: true })
      .catch(() => undefined);
  });

  it('writeJson and readJson round trip preserves data', async () => {
    const payload = {
      foo: 'bar',
      nested: { count: 3 },
      list: [1, 2, 3],
    };

    await TestRelativeFS.writeJson('sample.json', payload);
    const result = await TestRelativeFS.readJson<typeof payload>('sample.json');

    assert.deepStrictEqual(result, payload);
  });
});
