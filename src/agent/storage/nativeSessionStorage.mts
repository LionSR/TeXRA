// Node imports
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
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

/** The native root owns an OS directory handle until closeRoot releases it. */
export type NativeStorageRoot = object;

type SQLiteValue = string | number | bigint | null | Uint8Array;

export interface NativeSqliteConnection {
  execute(
    sql: string,
    bindings: readonly unknown[],
    options?: { readonly safeIntegers?: boolean },
  ): {
    readonly rows: readonly Readonly<Record<string, SQLiteValue>>[];
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  };
  values(
    sql: string,
    bindings: readonly unknown[],
    options?: { readonly safeIntegers?: boolean },
  ): readonly (readonly SQLiteValue[])[];
  exec(sql: string): void;
  close(): void;
}

interface NativeSessionStorageBinding {
  loadedModulePath(): string;
  openDatabase(
    root: NativeStorageRoot,
    filename: string,
  ): NativeSqliteConnection;
  openMemoryDatabase(): NativeSqliteConnection;
  openRoot(path: string): NativeStorageRoot;
  removeExecutionDirectories(
    root: NativeStorageRoot,
    directoryName: string,
    executionIds: readonly string[],
  ): Promise<void>;
  closeRoot(root: NativeStorageRoot): void;
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
  throw new Error(`Native session storage is unavailable for ${target}`);
const binaryPath = fileURLToPath(new URL(binary, import.meta.url));

function binding(): NativeSessionStorageBinding {
  return require(binaryPath) as NativeSessionStorageBinding;
}

export function openRoot(path: string): NativeStorageRoot {
  return binding().openRoot(path);
}

export function removeExecutionDirectories(
  root: NativeStorageRoot,
  directoryName: string,
  executionIds: readonly string[],
): Promise<void> {
  return binding().removeExecutionDirectories(
    root,
    directoryName,
    executionIds,
  );
}

export function closeRoot(root: NativeStorageRoot): void {
  binding().closeRoot(root);
}

/** Load the host's public SQLite API table before opening a native connection.
 * The bootstrap has no tables or filesystem location. The N-API module keeps
 * the library loaded after the bootstrap closes; the engine belongs to Node. */
function openSqlite(
  open: (native: NativeSessionStorageBinding) => NativeSqliteConnection,
): NativeSqliteConnection {
  const native = binding();
  const bootstrap = new DatabaseSync(':memory:', { allowExtension: true });
  try {
    bootstrap.loadExtension(native.loadedModulePath());
    return open(native);
  } finally {
    bootstrap.close();
  }
}

export function openDatabase(
  root: NativeStorageRoot,
  filename: string,
): NativeSqliteConnection {
  return openSqlite((native) => native.openDatabase(root, filename));
}

export function openMemoryDatabase(): NativeSqliteConnection {
  return openSqlite((native) => native.openMemoryDatabase());
}
