# Security Policy

## Supported versions

TeXRA is under active development. Security fixes are applied to the latest
released version of the extension, desktop app, and CLI. Please make sure you
are on the most recent release before reporting an issue.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's
[Security Advisories](https://github.com/texra-ai/texra-issues/security/advisories/new)
("Report a vulnerability"). This keeps the report confidential until a fix is
available.

If you are unable to use GitHub Security Advisories, you may contact the
maintainers at [contact@texra.ai](mailto:contact@texra.ai).

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof-of-concept.
- The affected component (extension, desktop, CLI, or shared core) and
  version.
- Any suggested mitigation, if you have one.

## What to expect

- We will acknowledge your report as soon as we can.
- We will investigate, keep you informed of progress, and work on a fix.
- Once a fix is released, we are happy to credit you for the discovery
  (unless you prefer to remain anonymous).

## Scope

TeXRA executes AI-driven workflows that can read and write files, run shell
commands, and call external model providers. When reporting, please consider:

- Handling of API keys and credentials (the extension stores keys in VS Code's
  encrypted SecretStorage; the CLI reads them from the environment).
- Tool-use approval gating and any way to bypass per-stream approval.
- Path traversal or unintended file access during workflows.
- Injection or unsafe handling of model output that is executed or rendered.

Thank you for helping keep TeXRA and its users safe.
