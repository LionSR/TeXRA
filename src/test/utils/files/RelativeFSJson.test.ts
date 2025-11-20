// Third-party imports
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';

// Local imports - utils
import { RelativeFS } from '@utils/files/relativeFS';

const BASE_DIR = path.join(os.tmpdir(), 'texra-relativefs-json-tests');

class TestRelativeFS extends RelativeFS {
  protected static override getBaseUri(): vscode.Uri {
    return vscode.Uri.file(BASE_DIR);
  }
}

describe('RelativeFS JSON helpers', () => {
  before(async () => {
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

  after(async () => {
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
