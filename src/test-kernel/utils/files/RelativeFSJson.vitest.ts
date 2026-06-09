// Third-party imports
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';

import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

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
