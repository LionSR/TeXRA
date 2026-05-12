import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const source = path.resolve(packageDir, '../extension/resources');
const target = path.resolve(packageDir, 'dist/resources');

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
