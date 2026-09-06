# Evidence for the September 6 agent architecture studies

The [HTML explorer](../../proposed/architecture/2026-09-06-agent-architecture.html), [decision study](../../proposed/architecture/2026-09-06-agent-architecture-study.md), [loop study](../../proposed/architecture/2026-09-06-agent-loop-architecture-study.md), [LLM package study](../../proposed/architecture/2026-09-06-llm-package-architecture-study.md), and [architectural review](../../proposed/architecture/2026-09-06-agent-architecture-review.md) are recommendations, not production changes. The review identifies four unresolved contract gaps and makes preservation of the reflection pipeline explicit.

## Source scope

TeXRA source is pinned at `cc22843af3fa7d8457b6899266a6e04bf15067e9`. An isolated study worktree was created from that revision; the live workspace's three untracked September 5 proposals were left untouched.

The external repositories were actually cloned with Git into a temporary research directory. [source-pins.json](./source-pins.json) records the examined branch, full commit, commit date and clone directory for each:

| Repository              | Branch | Examined commit                            |
| ----------------------- | ------ | ------------------------------------------ |
| danieljvdm/effect-agent | main   | `bedf7f8f016a50724390f436939488cf348a5400` |
| anomalyco/opencode      | dev    | `337fd144d2ba144743368f78d9579a99cce175bd` |
| earendil-works/pi       | main   | `9767ba275f3e9a5ee0f5c5342249b629ab1b2282` |
| Effect-TS/effect        | main   | `77f85fe1613348f5c990016b49dc97e252576c82` |

“Latest” means these branch heads fetched on September 6, not a claim that an upstream repository cannot change afterward. The OpenCode `DESIGN.md` discussion draft is distinguished from its implemented private LLM package. Pi's new harness is distinguished from older loop code and its experimental coding-agent worker integration. No historical migration path is recommended as the TeXRA target.

The studies use code, package manifests, repository design documents and official documentation. Provider behavior is source-traced, not live-tested. GitHub issue/PR state was refreshed on September 6, including #11867, #11868 and #11919; those coordination records can change independently of the pinned code.

## Reproduce the source census

Use a TeXRA source checkout at the pinned `cc22843af3fa7d8457b6899266a6e04bf15067e9` revision, with an installed TeXRA checkout supplying TypeScript. Run the script from this PR checkout:

```sh
node agents/docs/evidence/2026-09-06-agent-architecture/source-census.mjs \
  /absolute/path/to/pinned-texra-source \
  /absolute/path/to/installed-texra \
  agents/docs/evidence/2026-09-06-agent-architecture/source-census.json
```

[source-census.mjs](./source-census.mjs) enumerates tracked `.ts` files under the handler directory and parses static import declarations using TypeScript's AST. Physical line counts include comments and blank lines. Whole-import `typeOnly` declarations are identified; mixed value/type imports are recorded as a value import declaration. `domainEdges` is a named-domain import inventory, not a complete transitive dependency graph. The 41 port members are the string literal types in `IModelHandler.ts` at the inspected revision.

[source-census.json](./source-census.json) records 71 files, 21,370 physical lines and the 41-member port. These are scope measures, not a proposed deletion count.

## Offline reference-library probe

```sh
node agents/docs/evidence/2026-09-06-agent-architecture/effect-ai-boundary-probe.mjs \
  /absolute/path/to/installed-texra
```

[effect-ai-boundary-probe.mjs](./effect-ai-boundary-probe.mjs) constructs a fake provider and a dynamic JSON Schema tool against installed `effect@4.0.0-rc.112`. It sends no network request and needs no credential. It asserts:

- With tool resolution disabled, one provider call returns the tool input unchanged, without a handler layer and without handler execution.
- With default resolution and a handler layer, one provider call executes one tool and includes its result; it does not perform the next provider turn.

The saved [result](./effect-ai-boundary-probe.json) is evidence about Effect AI's boundary only. TeXRA is to build its own LLM package; this probe is not an implementation spike, provider parity test, durability test, or reason to install Effect AI.

## Diagrams and HTML

[ownership.mmd](./ownership.mmd), [current-ownership.mmd](./current-ownership.mmd), [llm-package.mmd](./llm-package.mmd), and [turn-lifecycle.mmd](./turn-lifecycle.mmd) are the editable Mermaid sources. Each was validated by rendering a temporary PNG before exporting its SVG with Mermaid CLI 11.17.0 and local Chrome. The SVGs are checked-in artifacts. The HTML embeds its current, proposed and LLM-package SVGs as data URLs and contains its own CSS, data and JavaScript; opening it requires no external asset or network call.

Example local render, using a Puppeteer configuration containing the installed Chrome executable path:

```sh
npx --yes --package @mermaid-js/mermaid-cli@11.17.0 mmdc \
  -i agents/docs/evidence/2026-09-06-agent-architecture/ownership.mmd \
  -o /tmp/texra-ownership-validation.png \
  -p /absolute/path/to/puppeteer-config.json -w 1600 -b white
```

After successful validation, use the same command with the desired `.svg` output path. If a diagram changes, update the embedded HTML diagram from the corresponding SVG too. The HTML's method list is a proposed allocation of all 41 census members; it is not a generated claim that each method survives the redesign.

## Link and artifact validation

```sh
node agents/docs/evidence/2026-09-06-agent-architecture/check-study-links.mjs \
  /absolute/path/to/study-checkout \
  /absolute/path/to/research-directory
```

[check-study-links.mjs](./check-study-links.mjs) verifies relative Markdown/HTML file links, each pinned GitHub source path, and the actual Git heads of the four research clones. It does not prove that prose accurately interprets each source; those claims were reviewed against the source separately.

The [validation record](./validation.json) separates artifact checks from the existing repository checks run before opening the draft PR. Passing those checks does not validate the proposed runtime, provider parity or recovery design; no new runtime implementation or live provider call is included here.

The research directory used by the link checker contains one Git clone per `cloneDirectory` in `source-pins.json`, checked out at the corresponding commit. Its location is arbitrary; no machine-specific path is required by the checked-in artifacts.
