# Security Policy

## Supported versions

TeXRA ships from a single release line across all three surfaces: the VS Code
extension, the desktop app, and `@texra-ai/cli`. Only the latest released
version gets security fixes. Please upgrade before reporting — see the
[changelog](./CHANGELOG.md) for what is current.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Email **contact@texra.ai** with `SECURITY` in the subject line, and include:

- what the issue is, and which surface it affects (extension, desktop, CLI, or
  the hosted account services at `remote.texra.ai`)
- the version you saw it on
- steps to reproduce, or a proof of concept
- the impact you believe it has

You will get an acknowledgement within 5 business days. TeXRA is a small team;
please allow time for a fix before disclosing publicly. We will tell you when a
fix ships, and will credit you in the changelog unless you would rather stay
anonymous.

## In scope

- **Credential storage and transport** — provider API keys (VS Code
  SecretStorage, the Electron keychain, the CLI credential store) and OAuth
  tokens.
- **Authentication flows** — OAuth callbacks and deep links, the device-code
  flow, and the auth bridge.
- **Agent tool execution** — shell, file-write, and edit tools, including the
  per-stream approval gate and anything that bypasses it.
- **Prompt injection that escalates privilege** — content in a user's documents,
  tool results, or fetched pages that makes an agent take an action the approval
  gate should have covered.
- **The hosted account services** — authentication, the remote-agent catalog,
  and usage-telemetry ingestion. Model requests are not proxied by TeXRA: they
  go from your machine straight to the provider.
- **Webview and renderer isolation** — the VS Code webviews and the Electron
  renderer, including navigation policy and any path from rendered content to
  host APIs.

## Out of scope

- Findings that require an already-compromised machine, or an attacker who
  already holds the user's provider API keys.
- The behaviour of third-party model providers. Report those to the provider.
- An agent producing wrong, low-quality, or unexpected content. File that as a
  bug.
- Missing hardening headers on the marketing site with no demonstrated impact.
- Automated scanner output with no accompanying analysis.

## Model credentials

TeXRA runs agents against model providers using your own API keys or provider
subscription credentials. Where a credential lives depends on how you supplied
it:

- **Entered through TeXRA** (`TeXRA: Set API Key`, the desktop credential
  settings, or `texra auth`) — stored in the host's secret store: VS Code
  SecretStorage, the Electron keychain, or the CLI credential store.
- **Supplied through the environment** — an exported variable, or a workspace
  `.env` that the extension loads at activation. These are read straight from
  the environment at request time and never enter any secret store. A `.env` is
  plain text in your workspace, so keep it out of version control.

Either way the key is sent only to the provider.

If you think a key of yours has been exposed by TeXRA, rotate it with your
provider first, then report it.
