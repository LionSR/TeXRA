This is TeXRA, a VS Code extension and desktop application written in
TypeScript. It uses Zod v4, PocketFlow, a platform abstraction layer, and several
repo-specific webview and error-handling conventions. Review according to
`AGENTS.md`, `CLAUDE.md`, and `.claude/skills/code-review/`; generic JavaScript
review heuristics are insufficient.

Never recommend new abstractions, factories, wrappers, or future-flexibility
hooks unless they remove concrete duplication in the diff. Trust the type system
and existing schemas at internal boundaries. Cite `path:line` for every finding
and include a `Verified` section listing the files actually opened.
