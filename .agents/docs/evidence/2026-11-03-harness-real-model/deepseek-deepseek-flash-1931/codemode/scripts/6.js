const schema = {
  type: "object",
  properties: {
    section: { type: "string" },
    claim: { type: "string" },
    supported: { type: "boolean" },
    reason: { type: "string" }
  },
  required: ["section", "claim", "supported", "reason"],
  additionalProperties: false
};

const r1 = await self(
  `Review round 1 of the LaTeX draft in the workspace (draft.tex). Check ONLY the first section, titled "Setup", whose body reads: "Let $K \\\\subset \\\\mathbb{R}^n$ be compact and $f\\\\colon K \\\\to \\\\mathbb{R}$ continuous." Decide whether the section's claim is supported by what the draft actually states. Return the section title, the claim, a boolean supported, and a one-sentence reason. Be strict: a bare assertion with no proof or citation, or a claim the text does not establish, is not supported.`,
  { fork: false, schema, label: "Review round 1: Setup" }
);

return { r1: r1.structured, runId: r1.runId, outcome: r1.outcome };
