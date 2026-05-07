import { appendFileSync } from 'node:fs';
import process from 'node:process';

const platform = process.argv[2];
const requireSigning = process.env.TEXRA_REQUIRE_DESKTOP_SIGNING === '1';

if (!['mac', 'win'].includes(platform)) {
  console.error('Usage: node scripts/verify-desktop-signing-env.mjs <mac|win>');
  process.exit(1);
}

function present(name) {
  return Boolean(process.env[name]);
}

function collectMissing(names) {
  return names.filter((name) => !present(name));
}

function hasAny(names) {
  return names.some((name) => present(name));
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function fail(message, missing = []) {
  console.error(message);
  for (const name of missing) console.error(`- missing ${name}`);
  process.exit(1);
}

function verifyMacSigning() {
  const certificateNames = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
  const apiKeyNames = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const appleIdNames = [
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ];
  const keychainNames = ['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'];
  const allNames = [
    ...certificateNames,
    ...apiKeyNames,
    ...appleIdNames,
    ...keychainNames,
  ];

  const certificateMissing = collectMissing(certificateNames);
  const apiKeyMissing = collectMissing(apiKeyNames);
  const appleIdMissing = collectMissing(appleIdNames);
  const keychainMissing = collectMissing(keychainNames);
  const hasCompleteNotarization =
    apiKeyMissing.length === 0 ||
    appleIdMissing.length === 0 ||
    keychainMissing.length === 0;
  const configured = certificateMissing.length === 0 && hasCompleteNotarization;
  const partial = hasAny(allNames) && !configured;

  if (configured) {
    writeOutput(
      'electron_builder_config',
      'electron-builder.signed.config.mjs',
    );
    writeOutput('signed', 'true');
    console.log(
      'macOS signing and notarization credentials are configured; using signed Electron Builder config.',
    );
    return;
  }

  writeOutput('electron_builder_config', 'electron-builder.yml');
  writeOutput('signed', 'false');

  if (partial || requireSigning) {
    const missing = [
      ...certificateMissing,
      ...(apiKeyMissing.length === apiKeyNames.length
        ? []
        : apiKeyMissing.map((name) => `${name} (API key notarization set)`)),
      ...(appleIdMissing.length === appleIdNames.length
        ? []
        : appleIdMissing.map((name) => `${name} (Apple ID notarization set)`)),
      ...(keychainMissing.length === keychainNames.length
        ? []
        : keychainMissing.map((name) => `${name} (keychain notarization set)`)),
    ];

    if (!hasCompleteNotarization) {
      missing.push(
        'one complete notarization set: APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, or APPLE_KEYCHAIN/APPLE_KEYCHAIN_PROFILE',
      );
    }

    fail('macOS desktop signing is incomplete.', missing);
  }

  console.log(
    'macOS signing credentials are not configured; packaging will remain unsigned.',
  );
}

function verifyWindowsSigning() {
  const azureConfigNames = [
    'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_PUBLISHER_NAME',
    'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_ENDPOINT',
    'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME',
    'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_ACCOUNT_NAME',
  ];
  const azureAuthNames = [
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
  ];
  const allNames = [...azureConfigNames, ...azureAuthNames];
  const missing = collectMissing(allNames);
  const configured = missing.length === 0;
  const partial = hasAny(allNames) && !configured;

  if (configured) {
    writeOutput(
      'electron_builder_config',
      'electron-builder.signed.config.mjs',
    );
    writeOutput('signed', 'true');
    console.log(
      'Windows Azure Trusted Signing credentials are configured; using signed Electron Builder config.',
    );
    return;
  }

  writeOutput('electron_builder_config', 'electron-builder.yml');
  writeOutput('signed', 'false');

  if (partial || requireSigning) {
    fail('Windows desktop signing is incomplete.', missing);
  }

  console.log(
    'Windows signing credentials are not configured; packaging will remain unsigned.',
  );
}

if (platform === 'mac') {
  verifyMacSigning();
} else {
  verifyWindowsSigning();
}
