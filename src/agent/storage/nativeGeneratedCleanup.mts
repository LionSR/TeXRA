// Node imports
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Native assets are copied by esbuild and resolved to file URLs by Vitest.
import binary0 from '../../../scripts/native-cleanup/prebuilds/darwin-x64.node';
import binary1 from '../../../scripts/native-cleanup/prebuilds/darwin-arm64.node';
import binary2 from '../../../scripts/native-cleanup/prebuilds/win32-x64.node';
import binary3 from '../../../scripts/native-cleanup/prebuilds/win32-arm64.node';
import binary4 from '../../../scripts/native-cleanup/prebuilds/win32-ia32.node';
import binary5 from '../../../scripts/native-cleanup/prebuilds/linux-x64-gnu.node';
import binary6 from '../../../scripts/native-cleanup/prebuilds/linux-arm64-gnu.node';
import binary7 from '../../../scripts/native-cleanup/prebuilds/linux-arm-gnu.node';
import binary8 from '../../../scripts/native-cleanup/prebuilds/linux-ppc64-gnu.node';
import binary9 from '../../../scripts/native-cleanup/prebuilds/linux-s390x-gnu.node';
import binary10 from '../../../scripts/native-cleanup/prebuilds/linux-x64-musl.node';
import binary11 from '../../../scripts/native-cleanup/prebuilds/linux-arm64-musl.node';

interface NativeCleanupBinding {
  removeExecutionDirectories(
    storage: string,
    directoryName: string,
    executionIds: readonly string[],
  ): Promise<void>;
}

const require = createRequire(import.meta.url);
const binaries: Readonly<Record<string, string>> = {
  'darwin-x64': binary0,
  'darwin-arm64': binary1,
  'win32-x64': binary2,
  'win32-arm64': binary3,
  'win32-ia32': binary4,
  'linux-x64-gnu': binary5,
  'linux-arm64-gnu': binary6,
  'linux-arm-gnu': binary7,
  'linux-ppc64-gnu': binary8,
  'linux-s390x-gnu': binary9,
  'linux-x64-musl': binary10,
  'linux-arm64-musl': binary11,
};

function linuxLibc(): string {
  const report = process.report.getReport() as {
    header: { glibcVersionRuntime?: string };
  };
  return report.header.glibcVersionRuntime ? 'gnu' : 'musl';
}

const target =
  process.platform === 'linux'
    ? `${process.platform}-${process.arch}-${linuxLibc()}`
    : `${process.platform}-${process.arch}`;
const binary = binaries[target];
if (!binary)
  throw new Error(`Native generated-file cleanup is unavailable for ${target}`);
const binaryPath = fileURLToPath(new URL(binary, import.meta.url));

function binding(): NativeCleanupBinding {
  return require(binaryPath) as NativeCleanupBinding;
}

export function removeExecutionDirectories(
  storage: string,
  directoryName: string,
  executionIds: readonly string[],
): Promise<void> {
  return binding().removeExecutionDirectories(
    storage,
    directoryName,
    executionIds,
  );
}
