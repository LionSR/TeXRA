# @texra-ai/cli

[![npm version](https://img.shields.io/npm/v/@texra-ai/cli?label=%40texra-ai%2Fcli)](https://www.npmjs.com/package/@texra-ai/cli)
[![CLI downloads](https://img.shields.io/npm/dm/@texra-ai/cli?label=CLI%20downloads)](https://www.npmjs.com/package/@texra-ai/cli)

TeXRA in your terminal — an open-source AI theorist for derivations, Lean 4
proofs, LaTeX editing, and multi-agent research workflows. Apache 2.0, using
your own model API keys or provider subscriptions.

## Install

Requires Node.js 22.22.2+ (22.x) or Node.js 24.15+.

```sh
npm install -g @texra-ai/cli

# Or via Homebrew (macOS / Linux)
brew install texra-ai/tap/texra
```

## Quick start

```sh
texra setup                                 # guided setup and first task
texra chat                                  # interactive terminal chat
texra run edit --input paper.tex            # polish a LaTeX file with diff output
texra run review --input paper.tex --print  # audit derivations and math
texra history list                          # browse past tasks
texra doctor                                # check credentials and LaTeX tools
```

## Credentials

Export a provider API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, etc.), place keys in a project `.env`, or
sign in with a subscription:

```sh
texra auth chatgpt login
texra auth grok login
```

Kimi Code and GLM Coding Plan subscriptions use their plan API keys. Everything
runs directly from your machine to your chosen provider with no TeXRA account.

## Shared across TeXRA apps

Task history, settings (`.texra/config.json` and `~/.texra`), and credentials
(`~/.texra/secrets/`) are shared with the
[VS Code extension](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
and the [Desktop App](https://github.com/texra-ai/texra-desktop-releases/releases).

## Documentation & Support

- [CLI Guide](https://texra.ai/guide/texra-cli)
- [Programs](https://texra.ai/guide/programs)
- [Models](https://texra.ai/guide/models)
- [Issues](https://github.com/LionSR/TeXRA/issues) · [contact@texra.ai](mailto:contact@texra.ai)

Licensed under [Apache-2.0](https://github.com/LionSR/TeXRA/blob/main/LICENSE).
© TeXRA Team 2024–2026.
