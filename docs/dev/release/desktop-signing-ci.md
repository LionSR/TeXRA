# Desktop Signing CI

The desktop installer jobs can sign release artifacts when the repository
secrets are configured. Local packaging commands still work without these
secrets and produce unsigned artifacts for development.

## macOS

The macOS installer job signs and notarizes with
`packages/desktop/electron-builder.signed.config.mjs` when it finds both a
Developer ID certificate and one complete Apple notarization credential set.

Required certificate secrets:

- `DESKTOP_MACOS_CSC_LINK` - base64, `file://`, HTTPS, or path value for the
  exported Developer ID Application certificate.
- `DESKTOP_MACOS_CSC_KEY_PASSWORD` - password for `DESKTOP_MACOS_CSC_LINK`.

Recommended notarization secrets:

- `DESKTOP_MACOS_APPLE_API_KEY` - contents of the downloaded `.p8` API key.
- `DESKTOP_MACOS_APPLE_API_KEY_ID`
- `DESKTOP_MACOS_APPLE_API_ISSUER`

The workflow also supports Electron Builder's Apple ID and keychain
notarization environment variables if the repository chooses that path later:

- `DESKTOP_MACOS_APPLE_ID`
- `DESKTOP_MACOS_APPLE_APP_SPECIFIC_PASSWORD`
- `DESKTOP_MACOS_APPLE_TEAM_ID`
- `DESKTOP_MACOS_APPLE_KEYCHAIN`
- `DESKTOP_MACOS_APPLE_KEYCHAIN_PROFILE`

## Windows

The Windows installer job signs with Azure Trusted Signing when all Azure
configuration and service-principal secrets are present.

Required Azure Trusted Signing configuration secrets:

- `DESKTOP_WINDOWS_AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`
- `DESKTOP_WINDOWS_AZURE_TRUSTED_SIGNING_ENDPOINT`
- `DESKTOP_WINDOWS_AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `DESKTOP_WINDOWS_AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`

Required Azure authentication secrets:

- `DESKTOP_WINDOWS_AZURE_TENANT_ID`
- `DESKTOP_WINDOWS_AZURE_CLIENT_ID`
- `DESKTOP_WINDOWS_AZURE_CLIENT_SECRET`

The service principal must have permission to use the Trusted Signing
certificate profile.

## Verification

Run the installer jobs manually from GitHub Actions with
`run_desktop_installers`, `run_windows_desktop`, and `require_desktop_signing`
enabled before relying on signed beta artifacts. With
`require_desktop_signing` enabled, CI fails fast if any required secret is
missing or only partially configured.

Without `require_desktop_signing`, CI uses signed configuration only when a
complete secret set is available. If no signing secrets are present, the jobs
continue producing unsigned installer artifacts for development validation.

## Failure Modes

- Missing or partial macOS secrets fail in the `Verify macOS signing secrets`
  step when signing is required, or whenever a partial secret set is present.
- Missing or partial Windows secrets fail in the
  `Verify Windows signing secrets` step under the same conditions.
- Apple notarization failures surface during the Electron Builder package step.
  Check Apple API key, issuer, team, bundle identifier, and Developer ID
  certificate validity.
- Azure Trusted Signing failures surface during the Windows package step. Check
  the endpoint region, publisher name, certificate profile name, signing account
  name, service-principal credentials, and role assignment.
