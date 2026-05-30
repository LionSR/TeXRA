<script setup>
import StagedWorkflowHero from '../.vitepress/components/StagedWorkflowHero.vue';
import QaChecklistCard from '../.vitepress/components/QaChecklistCard.vue';
import ModelTierMatrixCard from '../.vitepress/components/ModelTierMatrixCard.vue';
</script>

# Best Practices

## Effective Prompting

Specific instructions reduce ambiguity - the model doesn't have to guess your intent and uses tokens more efficiently for your actual goal.

### Be Specific

Instead of "Make this better", try:

> Improve the clarity of the methodology section by simplifying complex sentences and adding transition phrases. Maintain all technical terminology.

### Define Boundaries

State what should and should not change:

> Enhance writing style in the introduction and discussion. Preserve all citations and mathematical expressions. Do not modify the results section.

### Provide Context

> Polish this abstract for submission to Nature Physics. Target audience: physicists with expertise in quantum field theory.

### Use Structured Instructions

For complex tasks:

> 1. Fix grammatical errors throughout
> 2. Make the introduction more engaging
> 3. Ensure consistent terminology
> 4. Improve transitions between sections

## Model Selection

Match model capability to task complexity - overpowered models waste money, underpowered ones produce poor results.

<ModelTierMatrixCard />

<p class="hero-caption">Find the row that matches your task, then pick one of the recommended model handles.</p>

See the [AI Models Guide](./models.md) for detailed comparisons.

## File Management

### Project Structure

```
project/
├── main.tex
├── chapters/
├── figures/
├── build/
├── history/
└── diffs/
```

### Best Practices

- Include only necessary files in selections
- Use the Pack button to preserve milestones
- Clean unnecessary outputs regularly

## Workflow Integration

### Staged Approach

A typical project moves through five stages, each owned by one or more agents:

<StagedWorkflowHero />

<p class="hero-caption">A typical project flows from research to finalization, with each stage handed to the agent best suited for it.</p>

### Quality Assurance

Always review AI-generated content - tick through the same checks after every run:

<QaChecklistCard />

<p class="hero-caption">A short review pass after each run catches the errors automation cannot see for itself.</p>

Use [LaTeX Diff](./latex-diff.md) to visualize changes between versions.

## LaTeX Tips

- Use logical document structure with proper sectioning
- Maintain clean preambles
- Use consistent label naming
- Comment TikZ code for clarity
- Use BibTeX consistently with a single bibliography file

## Next Steps

- [Configuration](/guide/configuration): Customize TeXRA
- [Custom Agents](/guide/custom-agents): Create specialized agents
- [Intelligent Merge](/guide/intelligent-merge): Merge document versions
