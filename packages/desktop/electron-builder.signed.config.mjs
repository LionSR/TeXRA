import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const configPath = fileURLToPath(
  new URL('electron-builder.yml', import.meta.url),
);
const baseConfig = YAML.parse(readFileSync(configPath, 'utf8')) ?? {};

function hasEnv(name) {
  return Boolean(process.env[name]);
}

function hasAppleNotarizationCredentials() {
  return (
    (hasEnv('APPLE_API_KEY') &&
      hasEnv('APPLE_API_KEY_ID') &&
      hasEnv('APPLE_API_ISSUER')) ||
    (hasEnv('APPLE_ID') &&
      hasEnv('APPLE_APP_SPECIFIC_PASSWORD') &&
      hasEnv('APPLE_TEAM_ID')) ||
    (hasEnv('APPLE_KEYCHAIN') && hasEnv('APPLE_KEYCHAIN_PROFILE'))
  );
}

function hasMacSigningCredentials() {
  return hasEnv('CSC_LINK') && hasEnv('CSC_KEY_PASSWORD');
}

function windowsAzureSignOptions() {
  const {
    TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: publisherName,
    TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_ENDPOINT: endpoint,
    TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME:
      certificateProfileName,
    TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: codeSigningAccountName,
  } = process.env;

  if (
    !publisherName ||
    !endpoint ||
    !certificateProfileName ||
    !codeSigningAccountName
  ) {
    return undefined;
  }

  return {
    publisherName,
    endpoint,
    certificateProfileName,
    codeSigningAccountName,
  };
}

const macSigningReady =
  hasMacSigningCredentials() && hasAppleNotarizationCredentials();
const azureSignOptions = windowsAzureSignOptions();

export default {
  ...baseConfig,
  mac: {
    ...baseConfig.mac,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: macSigningReady,
    forceCodeSigning: macSigningReady,
  },
  win: {
    ...baseConfig.win,
    ...(azureSignOptions
      ? {
          azureSignOptions,
          forceCodeSigning: true,
        }
      : {}),
  },
};
