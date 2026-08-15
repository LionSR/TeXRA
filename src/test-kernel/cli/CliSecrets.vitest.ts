import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CliSecrets, cliSecretsPath } from '@cli/runtime/cliSecrets';
import { withTempDir } from '@test/support/tempDirPlatform';

async function withSecretsRoot(
  run: (paths: {
    root: string;
    storageRoot: string;
    secretsPath: string;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir('texra-cli-secrets-', async (root) => {
    const storageRoot = path.join(root, 'storage');
    await run({ root, storageRoot, secretsPath: cliSecretsPath(storageRoot) });
  });
}

describe('CLI secrets', () => {
  // POSIX file modes don't exist on Windows. skipIf (rather than an early
  // return) so the skip is visible in reports instead of a zero-assertion pass.
  const itPosix = it.skipIf(process.platform === 'win32');

  it('stores secrets under the configured storage root', async () => {
    await withSecretsRoot(async ({ storageRoot, secretsPath }) => {
      const secrets = new CliSecrets(secretsPath);
      await secrets.set('TEXRA_CLI_SECRETS_TEST_KEY', 'test-key');

      expect(await secrets.get('TEXRA_CLI_SECRETS_TEST_KEY')).toBe('test-key');
      await expect(fs.readFile(secretsPath, 'utf8')).resolves.toContain(
        'TEXRA_CLI_SECRETS_TEST_KEY',
      );
      expect(path.dirname(secretsPath)).toBe(storageRoot);
    });
  });

  it('aborts a write instead of wiping the file when the read fails for a reason other than a missing file', async () => {
    await withSecretsRoot(async ({ secretsPath }) => {
      const secrets = new CliSecrets(secretsPath);
      await secrets.set('EXISTING_KEY', 'existing-value');

      // Corrupt the on-disk file to simulate a non-ENOENT read failure
      // (e.g. corrupt JSON, or an EACCES/EMFILE on the real fs.readFile).
      await fs.writeFile(secretsPath, '{ not valid json', 'utf8');

      await expect(secrets.set('NEW_KEY', 'new-value')).rejects.toThrow();

      // The mutation must have aborted rather than overwriting the file
      // with a fresh `{}` merged with just the new key.
      const onDisk = await fs.readFile(secretsPath, 'utf8');
      expect(onDisk).toBe('{ not valid json');

      // The queue must not be stuck: a subsequent read/write still works.
      await fs.writeFile(
        secretsPath,
        '{"EXISTING_KEY":"existing-value"}\n',
        'utf8',
      );
      await secrets.set('ANOTHER_KEY', 'another-value');
      expect(await secrets.get('EXISTING_KEY')).toBe('existing-value');
      expect(await secrets.get('ANOTHER_KEY')).toBe('another-value');
    });
  });

  it('merges overlapping set() calls instead of one silently dropping the other', async () => {
    await withSecretsRoot(async ({ secretsPath }) => {
      const secrets = new CliSecrets(secretsPath);

      // Two overlapping mutations on the same instance, started before
      // either resolves. Without intra-process serialization, each opens
      // its own JsonStore off the same on-disk snapshot and the later
      // flush silently drops the other's key.
      await Promise.all([
        secrets.set('KEY_A', 'value-a'),
        secrets.set('KEY_B', 'value-b'),
        secrets.set('ORDERED_KEY', 'old-value'),
        secrets.set('ORDERED_KEY', 'new-value'),
      ]);

      expect(await secrets.get('KEY_A')).toBe('value-a');
      expect(await secrets.get('KEY_B')).toBe('value-b');
      expect(await secrets.get('ORDERED_KEY')).toBe('new-value');
    });
  });

  it('ignores a non-string stored value instead of returning it as a key', async () => {
    await withSecretsRoot(async ({ secretsPath }) => {
      const secrets = new CliSecrets(secretsPath);
      await secrets.set('GOOD_KEY', 'good-value');
      await fs.writeFile(
        secretsPath,
        JSON.stringify({ GOOD_KEY: 'good-value', BAD_KEY: { nested: true } }),
        'utf8',
      );

      expect(await secrets.getStored('GOOD_KEY')).toBe('good-value');
      expect(await secrets.getStored('BAD_KEY')).toBeUndefined();
    });
  });

  itPosix(
    'serves env-provided secrets when the storage directory cannot be created',
    async () => {
      await withSecretsRoot(async ({ root, secretsPath }) => {
        // `storage/` does not exist and its parent is unwritable, so any
        // open-time `mkdir`/`chmod` on the read path throws (#8220). Reads must
        // degrade to "nothing stored" and let env vars keep working.
        await fs.chmod(root, 0o500);
        vi.stubEnv('TEXRA_CLI_SECRETS_ENV_ONLY_KEY', 'env-value');

        try {
          const secrets = new CliSecrets(secretsPath);

          await expect(
            secrets.get('TEXRA_CLI_SECRETS_ENV_ONLY_KEY'),
          ).resolves.toBe('env-value');
          await expect(
            secrets.getStored('TEXRA_CLI_SECRETS_ENV_ONLY_KEY'),
          ).resolves.toBeUndefined();
          await expect(
            secrets.get('TEXRA_CLI_SECRETS_MISSING_KEY'),
          ).resolves.toBeUndefined();
          await expect(secrets.listStoredKeys()).resolves.toEqual([]);
        } finally {
          vi.unstubAllEnvs();
          await fs.chmod(root, 0o700);
        }
      });
    },
  );

  itPosix(
    'restricts the secrets file and its directory to the owner',
    async () => {
      await withSecretsRoot(async ({ secretsPath }) => {
        const secrets = new CliSecrets(secretsPath);
        await secrets.set('TEXRA_CLI_SECRETS_TEST_KEY', 'test-key');

        const fileStat = await fs.stat(secretsPath);
        const dirStat = await fs.stat(path.dirname(secretsPath));
        expect(fileStat.mode & 0o777).toBe(0o600);
        expect(dirStat.mode & 0o777).toBe(0o700);
      });
    },
  );

  it('keeps one process-wide secrets store after the first root is selected', async () => {
    vi.resetModules();
    const { getCliSecrets } = await import('@cli/runtime/cliSecrets');

    await withSecretsRoot(async ({ root, storageRoot }) => {
      const first = getCliSecrets(storageRoot);
      const second = getCliSecrets();
      const third = getCliSecrets(path.join(root, 'other-storage'));

      expect(second).toBe(first);
      expect(third).toBe(first);
    });
  });
});
