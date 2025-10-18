# Agents at a Glance

TeXRA ships with a roster of agents tuned for theorists who demand receipts. Think of this page as the casting call: each agent's personality, ideal jobs, and where to learn more. For full specifications, visit the [Built-in Agent Reference](./built-in-agents.md); this overview keeps things punchy.

## Conversational duo

- **`ask`** – Read-only scout for contextual Q&A. Perfect for recon runs, citing prior work, or prepping instructions without touching the filesystem. Deep dive in the [Ask & Chat Guide](./ask-chat.md).
- **`chat`** – Tool-wielding scientist who applies plans, edits files, and executes shell commands. Use it to launch derivations, coordinate multi-step workflows, or sanity-check outputs before calling the specialists.

## Derivation & analysis

- **`derive`** – Expands math into `\begin{aligned}` blocks you can drop straight into LaTeX. Ideal for reviewer rebuttals, appendix material, or filling in hand-wavy notes.
- **`correct`** – Surgical proofreader that fixes typos, notation errors, and LaTeX syntax while leaving your style intact.
- **`polish`** – Makes prose readable without compromising technical content. Use it after `derive` to clean transitions.

## Transformation squad

- **`paper2slide`** – Converts manuscripts into Beamer outlines with sensible sectioning.
- **`paper2poster`** – Produces conference-ready poster scaffolds from dense drafts.
- **`paper2note`** – Distills papers into lecture notes when you need teaching material fast.
- **`paper2cover`** – Drafts cover letters anchored in your manuscript's real contributions.

## Figure & media agents

- **`draw`** – Generates or revises TikZ diagrams from textual descriptions.
- **`ocr`** – Extracts text from images or PDFs so you can quote or search the content.
- **`transcribe_audio`** – Turns supported audio inputs into transcripts for later annotation.

## Customizing the roster

Want a bespoke derivation partner or an agent that quotes your internal style guide? Head over to [Custom Agents](./custom-agents.md) for YAML scaffolding, tool permissions, and derivation templates. Combine those with the [Ask & Chat Guide](./ask-chat.md) to build multi-agent routines that stay auditable from the first question to the final PDF.
