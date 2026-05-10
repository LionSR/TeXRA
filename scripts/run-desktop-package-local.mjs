#!/usr/bin/env node
// Wrapper for `desktop:package:local` that auto-detects a locally installed
// "TeXRA Dev" code-signing identity and exports it as CSC_NAME, so every dev
// rebuild produces the same code signature. Without a stable identity each
// ad-hoc-signed rebuild gets a different code directory hash and macOS
// re-prompts for keychain access on every launch.
//
// Falls back to ad-hoc signing when the cert is absent or we are not on macOS.
import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';

const DEV_IDENTITY_NAME = 'TeXRA Dev';

function detectMacSigningIdentity() {
  if (process.platform !== 'darwin') return null;
  if (process.env.CSC_NAME || process.env.CSC_LINK) return null;
  try {
    const output = execFileSync(
      'security',
      ['find-identity', '-p', 'codesigning', '-v'],
      { encoding: 'utf8' },
    );
    return output.includes(`"${DEV_IDENTITY_NAME}"`) ? DEV_IDENTITY_NAME : null;
  } catch {
    return null;
  }
}

const identity = detectMacSigningIdentity();
const env = { ...process.env };
if (identity) {
  env.CSC_NAME = identity;
  console.log(
    `[desktop:package:local] Using local signing identity "${identity}".`,
  );
} else if (process.platform === 'darwin' && !process.env.CSC_LINK) {
  console.log(
    `[desktop:package:local] No "${DEV_IDENTITY_NAME}" code-signing identity found; falling back to ad-hoc.`,
  );
  console.log(
    '  Tip: create a self-signed cert via Keychain Access → Certificate Assistant →',
  );
  console.log(
    `        Create a Certificate, name "${DEV_IDENTITY_NAME}", Self Signed Root, Code Signing.`,
  );
}

function runCorepack(args) {
  return spawnSync('corepack', args, { stdio: 'inherit', env });
}

const buildResult = runCorepack(['pnpm', 'run', 'desktop:build']);
if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}
const packageResult = runCorepack([
  'pnpm',
  '--filter',
  '@texra/desktop',
  'package:dir',
]);
process.exit(packageResult.status ?? 1);
