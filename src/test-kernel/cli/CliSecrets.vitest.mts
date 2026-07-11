import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CliSecrets, cliSecretsPath } from '@cli/runtime/cliSecrets';

describe('CLI secrets', () => {
  it('stores secrets under the configured storage root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-secrets-'));
    const storageRoot = path.join(root, 'storage');
    const secretsPath = cliSecretsPath(storageRoot);

    try {
      const secrets = new CliSecrets(secretsPath);
      await secrets.set('TEXRA_CLI_SECRETS_TEST_KEY', 'test-key');

      expect(await secrets.get('TEXRA_CLI_SECRETS_TEST_KEY')).toBe('test-key');
      await expect(fs.readFile(secretsPath, 'utf8')).resolves.toContain(
        'TEXRA_CLI_SECRETS_TEST_KEY',
      );
      expect(path.dirname(secretsPath)).toBe(storageRoot);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('aborts a write instead of wiping the file when the read fails for a reason other than a missing file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-secrets-'));
    const storageRoot = path.join(root, 'storage');
    const secretsPath = cliSecretsPath(storageRoot);

    try {
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('restricts the secrets file and its directory to the owner', async () => {
    if (process.platform === 'win32') return; // POSIX modes don't apply.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-secrets-'));
    const storageRoot = path.join(root, 'storage');
    const secretsPath = cliSecretsPath(storageRoot);

    try {
      const secrets = new CliSecrets(secretsPath);
      await secrets.set('TEXRA_CLI_SECRETS_TEST_KEY', 'test-key');

      const fileStat = await fs.stat(secretsPath);
      const dirStat = await fs.stat(path.dirname(secretsPath));
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(dirStat.mode & 0o777).toBe(0o700);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps one process-wide secrets store after the first root is selected', async () => {
    vi.resetModules();
    const { getCliSecrets } = await import('@cli/runtime/cliSecrets');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-secrets-'));
    const storageRoot = path.join(root, 'storage');
    const otherStorageRoot = path.join(root, 'other-storage');

    try {
      const first = getCliSecrets(storageRoot);
      const second = getCliSecrets();
      const third = getCliSecrets(otherStorageRoot);

      expect(second).toBe(first);
      expect(third).toBe(first);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
