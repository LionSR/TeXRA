// The build identity every TeXRA bundle carries: the workspace version from
// the root package.json, which the release bumps for every package at once
// and which no host renumbers (a preview VSIX is renumbered in its own
// manifest only). The background service reports it, and a client retires
// an older service by it (`BUILD_VERSION` in
// packages/harness/src/controllers/server/protocol.ts). `TEXRA_BUILD_VERSION` in the build's
// environment overrides it, for a validation that needs two builds.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPackage = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json',
);

/** The esbuild `define` entry that stamps the build identity. */
export function buildIdentityDefine() {
  const version =
    process.env.TEXRA_BUILD_VERSION?.trim() ||
    JSON.parse(readFileSync(rootPackage, 'utf8')).version;
  return { 'process.env.TEXRA_BUILD_VERSION': JSON.stringify(version) };
}
