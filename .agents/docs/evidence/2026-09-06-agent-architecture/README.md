# Evidence for the LLM package architecture study

These artifacts back the [LLM package study](../../implemented/architecture/2026-09-06-llm-package-architecture-study.md) and the [LLM runtime contract](../../implemented/architecture/2026-09-06-llm-runtime-contract.md). The studies are recommendations, not production changes. The other September 6 studies and the HTML explorer this folder once supported are deleted; version-control history has them.

## Source scope

TeXRA source is pinned at `cc22843af3fa7d8457b6899266a6e04bf15067e9`. [source-pins.json](./source-pins.json) records the examined branch, full commit, commit date and clone directory of each external repository (danieljvdm/effect-agent, anomalyco/opencode, earendil-works/pi, Effect-TS/effect), fetched on September 6, 2026. "Latest" means those branch heads on that date. Provider behavior is source-traced, not live-tested.

## Reproduce the source census

Use a TeXRA source checkout at the pinned revision, with an installed TeXRA checkout supplying TypeScript:

```sh
node .agents/docs/evidence/2026-09-06-agent-architecture/source-census.mjs \
  /absolute/path/to/pinned-texra-source \
  /absolute/path/to/installed-texra \
  .agents/docs/evidence/2026-09-06-agent-architecture/source-census.json
```

[source-census.mjs](./source-census.mjs) enumerates tracked `.ts` files under the handler directory and parses static import declarations with TypeScript's AST. Physical line counts include comments and blank lines; `domainEdges` is a named-domain import inventory, not a transitive dependency graph. [source-census.json](./source-census.json) records 71 files, 21,370 physical lines and the 41-member `IModelHandler.ts` port. These are scope measures, not a proposed deletion count.

## Offline reference-library probe

```sh
node .agents/docs/evidence/2026-09-06-agent-architecture/effect-ai-boundary-probe.mjs \
  /absolute/path/to/installed-texra
```

[effect-ai-boundary-probe.mjs](./effect-ai-boundary-probe.mjs) builds a fake provider and a dynamic JSON Schema tool against installed `effect@4.0.0-rc.112`, with no network and no credential. It asserts that with tool resolution disabled one provider call returns the tool input unchanged, and that with default resolution and a handler layer one call executes one tool and includes its result without a next provider turn. The saved [result](./effect-ai-boundary-probe.json) is evidence about Effect AI's boundary only, not a reason to install it.

## Diagram

[llm-package.mmd](./llm-package.mmd) is the editable Mermaid source of the checked-in [llm-package.svg](./llm-package.svg), rendered with Mermaid CLI 11.17.0:

```sh
npx --yes --package @mermaid-js/mermaid-cli@11.17.0 mmdc \
  -i .agents/docs/evidence/2026-09-06-agent-architecture/llm-package.mmd \
  -o llm-package.svg -p /absolute/path/to/puppeteer-config.json -b white
```
