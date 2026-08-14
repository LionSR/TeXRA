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
// and exits 1 when the SQL file passed via -f matches $TEXRA_STUB_FAIL.
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
} >> "$TEXRA_STUB_LOG"
if [ -n "$TEXRA_STUB_FAIL" ]; then
  case "$file" in
    *"$TEXRA_STUB_FAIL"*) exit 1 ;;
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
  delete env.TEXRA_STUB_FAIL;
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
    it('restores a previously linked project-ref after a successful run', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
        });

        expect(result.status, result.stderr).toBe(0);
        // The CLI observed the substituted ref during the run...
        expect(readStubLog(root)).toContain('observed-ref: proj-b');
        // ...and the checkout's link state is back to proj-a afterwards.
        expect(readFileSync(projectRefPath(root), 'utf8')).toBe('proj-a\n');
        expect(result.stderr).toContain(
          'substituting SUPABASE_PROJECT_REF=proj-b',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('removes the project-ref it created when the checkout had no link state', () => {
      const root = createFixtureCheckout();
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
        });

        expect(result.status, result.stderr).toBe(0);
        expect(readStubLog(root)).toContain('observed-ref: proj-b');
        expect(existsSync(projectRefPath(root))).toBe(false);
        expect(existsSync(join(root, 'supabase/.temp'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('restores the link state when the apply itself fails', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
          TEXRA_STUB_FAIL: 'remote-agents.sql',
        });

        expect(result.status).toBe(1);
        expect(readFileSync(projectRefPath(root), 'utf8')).toBe('proj-a\n');
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

    it('refuses to publish metadata when the storage preflight fails', () => {
      const root = createFixtureCheckout('proj-a');
      try {
        const result = runSync(root, ['--apply'], {
          SUPABASE_PROJECT_REF: 'proj-b',
          TEXRA_STUB_FAIL: 'preflight',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Storage preflight failed');
        // The catalog SQL itself was never sent to the CLI.
        const invocations = readStubLog(root)
          .split('\n')
          .filter((line) => line.startsWith('args:'));
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toContain('remote-agents-preflight.sql');
        // The failed run still restored the checkout's link state.
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
