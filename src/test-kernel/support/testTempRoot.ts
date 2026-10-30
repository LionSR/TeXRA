/**
 * Every temp folder a test run makes lives in one folder of the run's own,
 * removed when the run ends. Vitest runs this global setup in its main
 * process before any worker starts, so pointing `TMPDIR` (and Windows' `TMP`
 * and `TEMP`) at the run's folder sends each worker's `os.tmpdir()`, and each
 * process a suite spawns, there. A worker's own `exit` handler is no guard:
 * the pool ends its workers with a signal, which skips it, and every run left
 * a temp home and a fake-platform folder per worker behind.
 *
 * A run killed before its teardown leaves its folder, named by its process:
 * the next run removes it once that process is gone.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PREFIX = 'texra-vitest-';
const OWNER = 'owner.pid';
const TEMP_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

/** Whether process `pid` still runs (another user's counts as running). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // cast: `process.kill` throws a Node system error.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The run folders under `tmp` whose run ended without its teardown. */
function abandoned(tmp: string): string[] {
  return readdirSync(tmp)
    .filter((name) => name.startsWith(PREFIX))
    .map((name) => path.join(tmp, name))
    .filter((dir) => {
      let owner: string;
      try {
        owner = readFileSync(path.join(dir, OWNER), 'utf8');
      } catch {
        // Unreadable: a run between creating its folder and naming itself
        // in it, another user's run (mkdtemp makes the folder private), or a
        // file that shares the prefix. Each is left alone, so the worst case
        // is a folder kept, never a live run's folder removed.
        return false;
      }
      const pid = Number.parseInt(owner, 10);
      return Number.isInteger(pid) && !running(pid);
    });
}

export default function setup(): () => void {
  const tmp = os.tmpdir();
  for (const dir of abandoned(tmp))
    rmSync(dir, { recursive: true, force: true });
  const root = realpathSync.native(mkdtempSync(path.join(tmp, PREFIX)));
  writeFileSync(path.join(root, OWNER), String(process.pid));
  const before = TEMP_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of TEMP_KEYS) process.env[key] = root;
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Vitest runs this before it waits for its last workers to exit, and a
    // dying worker can still hold a file (Windows refuses to remove it) or
    // write one (the folder is not yet empty): retry until they are gone.
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  };
}
