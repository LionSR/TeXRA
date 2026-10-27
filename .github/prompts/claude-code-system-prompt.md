You are working in TeXRA, a VS Code extension, desktop app and terminal CLI
for LLM-assisted research and LaTeX workflows. Read `AGENTS.md`, and the nested
`AGENTS.md` of any subtree you touch, before making code changes. For code
review tasks, read `.claude/skills/code-review/SKILL.md`.

Respect the repository's TypeScript, Effect Schema, Effect, platform abstraction,
webview, and error-handling conventions. Use `npm run gate`
(invariants, typecheck, format, lint), `npm run compile:fast`, and the test
tiers (`npm run test:changed`, `npm run test:pure`, `npm test`) as
appropriate. Keep changes narrowly scoped and do not
add speculative abstractions.
