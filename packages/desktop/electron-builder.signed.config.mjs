import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

// The signed build; `electron-builder.yml` is the unsigned one. The installer
// job's `node scripts/verify-desktop.mjs signing-env` chooses this config only
// once a platform's credentials are complete, so it signs unconditionally: a
// missing signing identity or Azure setting fails the build instead of
// building unsigned. (A missing App Store Connect key is electron-builder's to
// report: it warns and skips notarization.)
const configPath = fileURLToPath(
  new URL('electron-builder.yml', import.meta.url),
);
const baseConfig = YAML.parse(readFileSync(configPath, 'utf8')) ?? {};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. electron-builder.signed.config.mjs always signs; package unsigned with electron-builder.yml.`,
    );
  }
  return value;
}

export default {
  ...baseConfig,
  mac: {
    ...baseConfig.mac,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: true,
    forceCodeSigning: true,
  },
  // electron-builder notarizes only the app; the workflow notarizes and
  // staples the signed DMG after packaging.
  dmg: {
    ...baseConfig.dmg,
    sign: true,
  },
  win: {
    ...baseConfig.win,
    forceCodeSigning: true,
    // Azure Trusted Signing runs where Windows is built; the macOS job has no
    // Azure settings to read.
    ...(process.platform === 'win32' && {
      azureSignOptions: {
        publisherName: requiredEnv(
          'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_PUBLISHER_NAME',
        ),
        endpoint: requiredEnv('TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_ENDPOINT'),
        certificateProfileName: requiredEnv(
          'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME',
        ),
        codeSigningAccountName: requiredEnv(
          'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_ACCOUNT_NAME',
        ),
      },
    }),
  },
};
