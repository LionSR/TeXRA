import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CliUsageError } from '@cli/runtime/cliContext';

/**
 * The literal token a file-taking flag accepts to mean "read from stdin".
 * clig.dev: where a flag takes a file, accept `-` for stdin so the CLI is
 * pipe-composable (`cat draft.tex | texra run <agent> --input -`).
 */
export const STDIN_INPUT_TOKEN = '-';

/** Prefix for the temporary cwd-local file stdin is materialized into. */
const STDIN_TEMP_PREFIX = '.texra-stdin-';

/**
 * Reads the entirety of a (presumably piped) stdin stream to a UTF-8 string.
 * Injected into {@link materializeStdinInput} so tests can supply content
 * without driving a real stdin.
 */
export type StdinReader = () => Promise<string>;

async function drainProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

let processStdinRead: Promise<string> | undefined;

/** Default reader: drains `process.stdin` once to a UTF-8 string. */
export const readProcessStdin: StdinReader = async () => {
  processStdinRead ??= drainProcessStdin();
  return processStdinRead;
};

/**
 * Read stdin and write it to a freshly-created temp file, returning that file's
 * absolute path. The downstream run pipeline is file-centric, so materializing
 * to a temp file keeps the file-based input path intact while letting callers
 * pipe content in. The temp file lives in `cwd` so LaTeX dependencies like
 * `\input{sections/intro}` keep resolving from the project root. It is removed
 * on process exit.
 *
 * Throws a {@link CliUsageError} when stdin is empty so the user sees a clear
 * "nothing piped in" message rather than running the agent against an empty
 * document.
 *
 * @param flagLabel CLI flag the `-` token came from (for the empty-input error)
 * @param readStdin injected stdin reader (defaults to draining process.stdin)
 * @param cwd run working directory where the temporary file should live
 */
export async function materializeStdinInput(
  flagLabel: string,
  readStdin: StdinReader = readProcessStdin,
  cwd?: string,
): Promise<string> {
  const content = await readStdin();
  if (content.trim().length === 0) {
    throw new CliUsageError(
      `${flagLabel} -: no data on stdin. Pipe content in, e.g. \`cat draft.tex | texra run <agent> ${flagLabel} -\`.`,
    );
  }

  const tempRoot = cwd ? path.resolve(cwd) : os.tmpdir();
  const tempPath = path.join(
    tempRoot,
    `${STDIN_TEMP_PREFIX}${process.pid}-${randomUUID()}.tex`,
  );
  await fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
  registerStdinTempCleanup(tempPath);
  return tempPath;
}

/**
 * Best-effort removal of the stdin temp file when the process exits. The
 * CLI process is short-lived per run, so an `exit` hook is sufficient and keeps
 * the call site free of run-spanning try/finally plumbing. `exit` handlers must
 * be synchronous, so this uses the sync rm variant.
 */
function registerStdinTempCleanup(tempPath: string): void {
  process.once('exit', () => {
    try {
      fsSync.rmSync(tempPath, { force: true });
    } catch {
      // Cleanup is best-effort; stale hidden temp files are harmless.
    }
  });
}
