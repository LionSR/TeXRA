# Security Policy

## Supported versions

TeXRA ships from a single release line across all three surfaces (VS Code
extension, desktop app, and `@texra-ai/cli`). Only the **latest released
version** receives security fixes. Please upgrade before reporting — see the
[changelog](./CHANGELOG.md) for what is current.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Email **contact@texra.ai** with `SECURITY` in the subject line. Please include:

- what the issue is, and which surface it affects (extension / desktop / CLI /
  the hosted relay at `remote.texra.ai`)
- the version you observed it on
- steps to reproduce, or a proof of concept
- the impact you believe it has

You should get an acknowledgement within **5 business days**. TeXRA is a small
team, so please allow reasonable time for a fix before disclosing publicly. We
will tell you when a fix ships and are glad to credit you in the changelog
unless you would rather stay anonymous.

## What is in scope

The parts of TeXRA that handle credentials and untrusted input are the areas
worth the most scrutiny:

- **Credential storage and transport** — provider API keys (VS Code
  SecretStorage, the Electron keychain, and the CLI's credential store), OAuth
  tokens, and relay access tokens.
- **The authentication flows** — OAuth callbacks and deep links, the device-code
  flow, and the auth bridge.
- **Agent tool execution** — shell, file-write, and edit tools, including the
  per-stream approval gate and anything that lets an agent act without it.
- **Prompt injection that escalates privilege** — content in a user's documents,
  tool results, or fetched pages that causes an agent to take an action the
  approval gate was supposed to cover.
- **The hosted relay** — authentication, tier enforcement, rate and spend
  limits.
- **Webview and renderer isolation** — the VS Code webviews and the Electron
  renderer, including navigation policy and any path from rendered content to
  host APIs.

## What is not in scope

- Findings that require an already-compromised machine or an attacker who
  already has the user's provider API keys.
- The behaviour of third-party model providers themselves. Report those to the
  provider.
- An agent producing wrong, low-quality, or unexpected _content_. That is a bug
  — please file it as one — not a vulnerability.
- Missing hardening headers or similar findings on the marketing site with no
  demonstrated impact.
- Automated scanner output with no accompanying analysis.

## A note on API keys

TeXRA runs agents against model providers using either your own API keys or
TeXRA's hosted relay. Keys you supply are stored by the host platform's secret
store and sent only to the provider (or to the relay, when a request is routed
through it). If you believe a key of yours has been exposed by TeXRA, rotate it
with your provider first, then report it — rotating immediately limits the
damage regardless of what we find.
