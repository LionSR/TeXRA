/**
 * Vitests for `defaultResolveWorkspaceRoot` — walks up from a file looking
 * for `lakefile.lean` or `lakefile.toml`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultResolveWorkspaceRoot } from '@tools/lean/direct/directLspAdapter';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'texra-lean-root-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('defaultResolveWorkspaceRoot', () => {
  it('finds lakefile.lean in the same directory', async () => {
    await writeFile(path.join(scratch, 'lakefile.lean'), '');
    await writeFile(path.join(scratch, 'Foo.lean'), '');
    const root = await defaultResolveWorkspaceRoot(
      path.join(scratch, 'Foo.lean'),
    );
    expect(root).toBe(scratch);
  });

  it('finds lakefile.toml two directories up', async () => {
    await writeFile(path.join(scratch, 'lakefile.toml'), '');
    const sub = path.join(scratch, 'a', 'b');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'Foo.lean'), '');
    const root = await defaultResolveWorkspaceRoot(path.join(sub, 'Foo.lean'));
    expect(root).toBe(scratch);
  });

  it('returns null when no lakefile is found in any ancestor', async () => {
    const sub = path.join(scratch, 'no-lake');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'Foo.lean'), '');
    const root = await defaultResolveWorkspaceRoot(path.join(sub, 'Foo.lean'));
    expect(root).toBeNull();
  });
});
