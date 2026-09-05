# Prompts

This directory is the public home for TeXRA-authored prompts that are not owned
by a specific package.

## Layout

- `agents/remote/workflow/` contains canonical workflow agents that TeXRA Cloud
  may deliver remotely for whole-document transformations.
- `agents/remote/tool_use/` contains canonical tool-use agents and specialists
  (including Lean 4 agents under `agents/remote/tool_use/Lean4/`).
- `.github/prompts/` contains the public prompts used by the repository's
  AI-powered GitHub workflows. They stay next to the workflow configuration
  rather than being duplicated here.

Package-owned prompts stay next to the code that packages them:

- `packages/extension/resources/agents/`
- `packages/extension/resources/tool_use_agents/`
- `packages/extension/resources/templates/`
- `packages/extension/resources/goal/`

Reusable agent skills stay under `skills/` and `.claude/skills/`, following the
directory conventions of the clients that load them. Runtime-generated prompt
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
