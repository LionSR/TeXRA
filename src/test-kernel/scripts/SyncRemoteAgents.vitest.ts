// Node imports
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scriptPath = resolve(repoRoot, 'scripts/sync-remote-agents.mjs');

const AGENT_YAML = `name: apply
description: Apply the planned edits.
settings:
  agentCategory: workflow
  tools:
    - apply_patch
`;

const PLACEMENT_CONFIG = JSON.stringify({
  agents: { apply: { folder: 'researcher', visibility: ['public'] } },
});

// Fake `supabase` CLI: logs every invocation plus the link state it observes,
// optionally logs the SQL file it received, and exits 1 when the SQL file
// passed via -f matches $TEXRA_STUB_FAIL.
const SUPABASE_STUB = `#!/bin/sh
file=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-f" ]; then file="$arg"; fi
  prev="$arg"
done
{
  printf 'args:'
  printf ' %s' "$@"
  printf '\\n'
  if [ -f supabase/.temp/project-ref ]; then
    printf 'observed-ref: %s\\n' "$(cat supabase/.temp/project-ref)"
  else
    printf 'observed-ref: <absent>\\n'
  fi
  printf 'observed-project-id: %s\\n' "\${SUPABASE_PROJECT_ID:-<absent>}"
  if [ -n "$TEXRA_STUB_LOG_SQL" ] && [ -n "$file" ] && [ -f "$file" ]; then
    printf 'sql-file: %s\\n' "$(basename "$file")"
    cat "$file"
    printf '\\n'
  fi
} >> "$TEXRA_STUB_LOG"
if [ -n "$TEXRA_STUB_FAIL" ]; then
  case "$file" in
    *"$TEXRA_STUB_FAIL"*)
      if [ -n "$TEXRA_STUB_FAIL_OUTPUT" ]; then
        printf '%s\\n' "$TEXRA_STUB_FAIL_OUTPUT"
      fi
      exit 1
      ;;
  esac
fi
exit 0
`;

function createFixtureCheckout(linkedRef?: string) {
  const root = mkdtempSync(join(tmpdir(), 'texra-remote-agents-test-'));
  mkdirSync(join(root, 'prompts/agents/remote'), { recursive: true });
  writeFileSync(join(root, 'prompts/agents/remote/apply.yaml'), AGENT_YAML);
  mkdirSync(join(root, 'docs/supabase'), { recursive: true });
  writeFileSync(
    join(root, 'docs/supabase/remote-agents.config.json'),
    PLACEMENT_CONFIG,
  );
  if (linkedRef !== undefined) {
    mkdirSync(join(root, 'supabase/.temp'), { recursive: true });
    writeFileSync(join(root, 'supabase/.temp/project-ref'), `${linkedRef}\n`);
  }
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/supabase'), SUPABASE_STUB, { mode: 0o755 });
  return root;
}

function runSync(
  root: string,
  args: readonly string[],
  overrides: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SUPABASE_DB_URL;
  delete env.SUPABASE_PROJECT_REF;
  delete env.SUPABASE_PROJECT_ID;
  delete env.TEXRA_STUB_FAIL;
  delete env.TEXRA_STUB_FAIL_OUTPUT;
  delete env.TEXRA_STUB_LOG_SQL;
  env.TEXRA_REMOTE_AGENTS_ROOT = root;
  env.TEXRA_STUB_LOG = join(root, 'stub.log');
  env.PATH = `${join(root, 'bin')}${delimiter}${env.PATH ?? ''}`;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env,
  });
}

function readStubLog(root: string) {
  return readFileSync(join(root, 'stub.log'), 'utf8');
}

function readStubSql(root: string, filename: string) {
  const log = readStubLog(root);
  const marker = `sql-file: ${filename}\n`;
  const start = log.indexOf(marker);
  if (start === -1) {
    throw new Error(`Stub log does not contain sql-file: ${filename}`);
  }
  const contentStart = start + marker.length;
  // Each stub invocation logs its args:/observed-* lines before the sql-file
  // body, so the next '\nargs: ' marks the end of this file's SQL. Slicing
  // there keeps the following invocation's log lines out of the result
  // (#10411).
  const nextInvocation = log.indexOf('\nargs: ', contentStart);
  const end = nextInvocation === -1 ? log.length : nextInvocation;
  return log.slice(contentStart, end);
}

function projectRefPath(root: string) {
  return join(root, 'supabase/.temp/project-ref');
}

describe('sync-remote-agents script (generate mode)', () => {
  it('prints the catalog SQL to stdout without touching the checkout', () => {
    const root = createFixtureCheckout('proj-a');
    try {
      const result = runSync(root, []);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('INSERT INTO remote_agents');
      expect(result.stdout).toContain('researcher/apply.yaml');
      expect(result.stderr).toBe('');
      expect(existsSync(join(root, 'stub.log'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The --apply tests drive a POSIX shell stub for the supabase CLI.
describe.skipIf(process.platform === 'win32')(
  'sync-remote-agents script (--apply)',
  () => {
    it('targets SUPABASE_PROJECT_REF through the CLI env without mutating the linked ref', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
        });

        expect(result.status, result.stderr).toBe(0);
        const log = readStubLog(root);
        // The CLI was pointed at proj-b without rewriting the checkout file.
        expect(log).toContain('observed-project-id: proj-b');
        expect(log).toContain('observed-ref: proj-a');
        // SUPABASE_PROJECT_ID only steers the CLI in combination with
        // --linked; without the flag the CLI would silently fall back to
        // --local (#10412).
        const invocations = log
          .split('\n')
          .filter((line) => line.startsWith('args:'));
        expect(invocations).toHaveLength(2);
        for (const invocation of invocations) {
          expect(invocation).toContain('--linked');
        }
        expect(readFileSync(projectRefPath(root), 'utf8')).toBe('proj-a\n');
        expect(result.stderr).not.toContain('substituting');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('trims SUPABASE_PROJECT_REF before passing it through as SUPABASE_PROJECT_ID', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: '  proj-b  ',
        });

        expect(result.status, result.stderr).toBe(0);
        // The CLI validates the env var without trimming, so the script must
        // hand it the unpadded ref (#10408).
        expect(readStubLog(root)).toContain('observed-project-id: proj-b\n');
        expect(readFileSync(projectRefPath(root), 'utf8')).toBe('proj-a\n');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('never creates a project-ref file when the checkout has no link state', () => {
      const root = createFixtureCheckout();
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
        });

        expect(result.status, result.stderr).toBe(0);
        const log = readStubLog(root);
        expect(log).toContain('observed-project-id: proj-b');
        // The ref file was absent *while the CLI ran*, not just afterwards:
        // the post-run existsSync checks alone would also pass if the file
        // were created and then cleaned up mid-run (#10412).
        expect(log).toContain('observed-ref: <absent>');
        const invocations = log
          .split('\n')
          .filter((line) => line.startsWith('args:'));
        expect(invocations).toHaveLength(2);
        for (const invocation of invocations) {
          expect(invocation).toContain('--linked');
        }
        expect(existsSync(projectRefPath(root))).toBe(false);
        expect(existsSync(join(root, 'supabase/.temp'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('scrubs an ambient SUPABASE_PROJECT_ID when falling back to the linked checkout', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_ID: 'proj-ambient',
        });

        expect(result.status, result.stderr).toBe(0);
        // The CLI ranks SUPABASE_PROJECT_ID above the link file, so the
        // script must hide the ambient value from the spawned CLI to keep
        // the checkout's linked project authoritative (#10407).
        expect(readStubLog(root)).toContain('observed-project-id: <absent>');
        expect(readStubLog(root)).toContain('observed-ref: proj-a');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('leaves the link state untouched when the apply itself fails', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
          TEXRA_STUB_FAIL: 'remote-agents.sql',
        });

        expect(result.status).toBe(1);
        expect(readFileSync(projectRefPath(root), 'utf8')).toBe('proj-a\n');
        expect(readStubLog(root)).toContain('observed-project-id: proj-b');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('runs the storage preflight before applying the catalog SQL', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
        });

        expect(result.status, result.stderr).toBe(0);
        const log = readStubLog(root);
        const preflightAt = log.indexOf('remote-agents-preflight.sql');
        const applyAt = log.indexOf('/remote-agents.sql');
        expect(preflightAt).toBeGreaterThanOrEqual(0);
        expect(applyAt).toBeGreaterThan(preflightAt);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('generates a storage preflight that checks the agent-configs bucket', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
          TEXRA_STUB_LOG_SQL: '1',
        });

        expect(result.status, result.stderr).toBe(0);
        const preflightSql = readStubSql(root, 'remote-agents-preflight.sql');
        expect(preflightSql).toContain('DO $$');
        expect(preflightSql).toContain('storage.objects');
        expect(preflightSql).toContain("bucket_id = 'agent-configs'");
        expect(preflightSql).toContain('researcher/apply.yaml');
        // The slice stops at the apply invocation: only the SQL body, ending
        // with the preflight's final line, no trailing stub-log lines.
        expect(preflightSql).not.toContain('observed-');
        expect(preflightSql.endsWith('$$;\n')).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses to publish metadata when the storage preflight reports missing objects', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
          TEXRA_STUB_FAIL: 'preflight',
          TEXRA_STUB_FAIL_OUTPUT:
            'ERROR: sync-remote-agents: 1 catalog storage path(s) missing from the agent-configs bucket: ' +
            'researcher/apply.yaml. Upload the YAML prompt bodies first ' +
            '(docs/supabase/SUPABASE_SETUP.md, Part 7). (SQLSTATE P0001)',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Storage preflight failed');
        expect(result.stderr).toContain(
          'Upload the missing YAML prompt bodies to the agent-configs bucket',
        );
        // The catalog SQL itself was never sent to the CLI.
        const invocations = readStubLog(root)
          .split('\n')
          .filter((line) => line.startsWith('args:'));
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toContain('remote-agents-preflight.sql');
        // The failed run still left the checkout's link state untouched.
        expect(readFileSync(projectRefPath(root), 'utf8')).toBe('proj-a\n');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('ignores the marker text when no ERROR: line carries it', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
          TEXRA_STUB_FAIL: 'preflight',
          // A non-RAISE failure whose output echoes the submitted SQL: the
          // marker appears verbatim in the RAISE source line but no
          // ERROR:-prefixed line carries it, so this is not the
          // missing-storage case and must not print upload guidance
          // (#10409).
          TEXRA_STUB_FAIL_OUTPUT:
            'ERROR: connection to server at "db.proj-b.supabase.co" failed: Connection refused\n' +
            "query context:     RAISE EXCEPTION 'sync-remote-agents: % catalog storage path(s) missing from the agent-configs bucket: %. " +
            "Upload the YAML prompt bodies first (docs/supabase/SUPABASE_SETUP.md, Part 7).',",
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Storage preflight failed');
        expect(result.stderr).not.toContain(
          'Upload the missing YAML prompt bodies to the agent-configs bucket',
        );
        const invocations = readStubLog(root)
          .split('\n')
          .filter((line) => line.startsWith('args:'));
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toContain('remote-agents-preflight.sql');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('reports other preflight failures without upload guidance', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
          TEXRA_STUB_FAIL: 'preflight',
          TEXRA_STUB_FAIL_OUTPUT: 'ERROR: connection refused',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Storage preflight failed');
        expect(result.stderr).not.toContain(
          'Upload the missing YAML prompt bodies to the agent-configs bucket',
        );
        const invocations = readStubLog(root)
          .split('\n')
          .filter((line) => line.startsWith('args:'));
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toContain('remote-agents-preflight.sql');
        expect(readFileSync(projectRefPath(root), 'utf8')).toBe('proj-a\n');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('leaves the link state untouched when applying via SUPABASE_DB_URL', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_DB_URL: 'postgres://localhost:5432/postgres',
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain('substituting');
        expect(readFileSync(projectRefPath(root), 'utf8')).toBe('proj-a\n');
        expect(readStubLog(root)).toContain('observed-ref: proj-a');
        expect(readStubLog(root)).toContain('observed-project-id: <absent>');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('fails with guidance when no connection is configured', () => {
      const root = createFixtureCheckout();
      try {
        const result = runSync(root, ['--apply']);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'set SUPABASE_DB_URL or SUPABASE_PROJECT_REF',
        );
        expect(existsSync(join(root, 'stub.log'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
