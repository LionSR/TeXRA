# Standalone Skill Authoring

The skills under `skills/` are intended to stand on their own. A person using one of these skills should not need access to this repository, any internal prompt history, or any project-specific runtime.

## Authoring rules

- Write each `SKILL.md` as a self-contained guide for the next agent who will use it.
- Keep frontmatter trigger text explicit about what the skill does and when to use it.
- Keep the body focused on workflow, quality bar, and failure modes.
- Put longer checklists into `references/` only when they materially help execution.
- Do not mention hidden context, source prompts, internal migration history, or repository provenance in the skill itself.
- Do not rely on private conventions unless they are restated inside the skill package.

## Packaging rules

- Treat `SKILL.md` as the core artifact.
- Treat `references/` as optional supporting material the skill may load when needed.
- Treat `agents/openai.yaml` as optional product metadata, not part of the core skill contract.

## Reader-facing standard

A user or agent opening a skill package in isolation should be able to answer:

- What is this skill for?
- When should I use it?
- What workflow should I follow?
- What quality bar am I aiming for?
- Where do I look if I need the deeper checklist?
