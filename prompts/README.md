# Prompts

This directory is the public home for TeXRA-authored prompts that are not owned
by a specific package.

## Layout

- `agents/remote/workflow/` contains the workflow agents TeXRA Cloud delivers
  to released versions that still load hosted agents. It serves those versions
  only: the build no longer reads it, and the agents the current app runs ship
  bundled (as copies) in `packages/extension/resources/agents/`.
- Every other bundled agent (the orchestrator, `search`, `simplifier`,
  `presenter`, `progressCheck`, …) ships in
  `packages/extension/resources/agents/`, which is its only source of
  truth. The Lean 4 agents belong to the lean4 tool plugin and
  ship in `packages/extension/resources/plugins/lean4/agents/`. The remote delivery path still accepts tool-use agents
  under `agents/remote/tool_use/`; none live there today.
- `agents/remote/catalog.json` gives each remote agent its storage folder and
  visibility; `npm run sync:remote-agents` turns it and the YAML into the
  hosted catalog SQL.
- `.github/prompts/` contains the public prompts used by the repository's
  AI-powered GitHub workflows. They stay next to the workflow configuration
  rather than being duplicated here.

Package-owned prompts stay next to the code that packages them:

- `packages/extension/resources/agents/`
- `packages/extension/resources/plugins/<id>/agents/`
- `packages/extension/resources/templates/`

Reusable agent skills stay under `packages/extension/resources/skills/` (the
product's bundled skills) and `.claude/skills/` (repo-development skills),
following the directory conventions of the clients that load them. Runtime-generated prompt
fragments stay beside their implementation in `src/` or `packages/`.

## Source-of-truth rules

- Production storage may copy a released prompt, but may not edit it or become
  its source of truth.
- Prompts must use general behavioral rubrics, not an identifiable person's
  name, private writing samples, voice or style calibration, feedback
  transcripts, biography, or account metadata. Public examples must be
  synthetic or have documented consent and a compatible license.
- User content, retrieved documents, model output, credentials, and account
  state are runtime inputs and must not be committed as prompt fixtures.
- Prompt changes require review of the final resolved prompt and representative
  behavior checks, not only a YAML or Markdown syntax check.
