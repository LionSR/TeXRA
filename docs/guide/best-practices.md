<script setup>
import StagedWorkflowHero from '../.vitepress/components/StagedWorkflowHero.vue';
import QaChecklistCard from '../.vitepress/components/QaChecklistCard.vue';
import ModelTierMatrixCard from '../.vitepress/components/ModelTierMatrixCard.vue';
</script>

# Best practices

## Effective prompting

Specific instructions reduce ambiguity: the model doesn't have to guess your intent and spends its tokens on your actual goal.

### Be specific

Instead of "Make this better", try:

> Improve the clarity of the methodology section by simplifying complex sentences and adding transition phrases. Maintain all technical terminology.

### Define boundaries

State what should and should not change:

> Enhance writing style in the introduction and discussion. Preserve all citations and mathematical expressions. Do not modify the results section.

### Provide context

> Polish this abstract for submission to Nature Physics. Target audience: physicists with expertise in quantum field theory.

### Use structured instructions

For complex tasks:

> 1. Fix grammatical errors throughout
> 2. Make the introduction more engaging
> 3. Ensure consistent terminology
> 4. Improve transitions between sections

## Model selection

Match model capability to task complexity: overpowered models waste money, underpowered ones produce poor results.

<ModelTierMatrixCard />

<p class="hero-caption">Find the row that matches your task, then pick one of the recommended model handles.</p>

Read the [AI models](./models.md) for detailed comparisons.

## File management

### Project structure

```
project/
├── main.tex
├── chapters/
├── figures/
├── build/
├── History/
└── Diffs/
```

### Best practices

- Include only the files the task needs in selections
- Use the Pack button to preserve milestones
- Clean unneeded outputs regularly

## Workflow integration

### Staged approach

A typical project moves through five stages, each owned by one or more agents:

<StagedWorkflowHero />

<p class="hero-caption">A typical project flows from research to finalization, with each stage handed to the agent best suited for it.</p>

### Quality assurance

Review AI-generated content after every run, using the same checks each time:

<QaChecklistCard />

<p class="hero-caption">A short review pass after each run catches the errors automation cannot see for itself.</p>

Use [LaTeX Diff](./latex-diff.md) to visualize changes between versions.

## LaTeX tips

- Use a logical document structure with proper sectioning
- Keep preambles clean
- Use consistent label naming
- Comment TikZ code for clarity
- Use BibTeX consistently with a single bibliography file

## Next steps

- [Configuration](/guide/configuration): Customize TeXRA
- [Custom agents](/guide/custom-agents): Create specialized agents
- [Intelligent Merge](/guide/intelligent-merge): Merge document versions
