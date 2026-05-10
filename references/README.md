# External references

This directory contains external repositories cloned for design reference. These references are not TeXRA source code and should not be imported, bundled, or copied wholesale into the product.

## OpenRouter skills

Path: `references/openrouter-skills`
Source: `https://github.com/OpenRouterTeam/skills`
Relevant reference: `references/openrouter-skills/skills/create-agent-tui/`

Use this reference for `texra chat` styling and interaction design:

- input styles
- tool-call display styles
- loader behavior
- session metadata presentation
- permission-prompt placement

Do not copy its generated agent harness into TeXRA. TeXRA already owns the agent loop, tool registry, approval lifecycle, logger, and session state. The useful boundary is the terminal outer shell, not the runtime architecture.
