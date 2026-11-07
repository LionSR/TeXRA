/** The repo root, for tests that read the repository from disk. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
