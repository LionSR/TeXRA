import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Create a fresh temp directory under `root` (default OS tmpdir) with `prefix`. */
export async function createTexraTempDir(
  prefix: string,
  root?: string,
): Promise<string> {
  return mkdtemp(path.join(root ?? tmpdir(), prefix));
}
