/** The repo root, for tests that read the repository from disk. */
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
