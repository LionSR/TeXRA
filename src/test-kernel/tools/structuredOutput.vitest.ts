// Third-party imports
import { describe, expect, vi } from 'vitest';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports - tools
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import type { RunId } from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { ReportReviewIssueTool } from '@tools/ReportReviewIssueTool';
import {
  buildTerminalTool,
  normalizeStructuredOutputSchema,
} from '@tools/structuredOutput';

function makeCapture() {
  return vi.fn<(value: unknown) => void>();
}

describe('normalizeStructuredOutputSchema', () => {
  it.effect('normalizes a JSON Schema object through the pinned Zod API', () =>
    Effect.gen(function* () {
      const jsonSchema = {
        type: 'object',
        properties: {
          title: { type: 'string' },
          count: { type: 'integer' },
        },
        required: ['title', 'count'],
        additionalProperties: false,
      };

      const normalized = normalizeStructuredOutputSchema(jsonSchema);
      const capture = makeCapture();
      const tool = buildTerminalTool(jsonSchema, capture);

      expect(normalized.jsonSchema).toMatchObject(jsonSchema);
      expect(yield* tool.call({ title: 'Lemma', count: 2 })).toMatchObject({
        status: 'executed',
      });
      expect(yield* tool.call({ title: 'Lemma' })).toMatchObject({
        status: 'error',
      });
    }),
  );

  it('rejects non-object and unconstrained roots at normalization time', () => {
    expect(() => normalizeStructuredOutputSchema({})).toThrow(/object.*root/);
    expect(() => normalizeStructuredOutputSchema(z.array(z.string()))).toThrow(
      /object.*root/,
    );
  });

  it('rejects regex-bearing sandbox schemas before host compilation', () => {
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: { value: { type: 'string', pattern: '(a+)+$' } },
      }),
    ).toThrow(/cannot use pattern/);
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            items: [{ type: 'string', pattern: '(a+)+$' }],
          },
        },
      }),
    ).toThrow(/cannot use pattern/);
  });

  it('allows output fields whose names match JSON Schema keywords', () => {
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          patternProperties: { type: 'string' },
        },
      }),
    ).not.toThrow();
  });

  it('rejects format, $ref, and prototype-polluting property keys', () => {
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: { at: { type: 'string', format: 'email' } },
      }),
    ).toThrow(/cannot use format/);
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: { child: { $ref: '#/$defs/x' } },
      }),
    ).toThrow(/cannot use \$ref/);
    // Real sandbox schemas arrive via JSON.parse, which creates an own
    // "__proto__" key (an object literal would set the prototype instead).
    const polluting = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as Record<string, unknown>;
    expect(() => normalizeStructuredOutputSchema(polluting)).toThrow(
      /cannot declare a "__proto__" property/,
    );
  });

  it('rejects sandbox schemas past the depth and node caps', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 15; i += 1) {
      deep = { type: 'object', properties: { next: deep } };
    }
    expect(() => normalizeStructuredOutputSchema(deep)).toThrow(
      /nested deeper than/,
    );

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 1100; i += 1) wide[`f${i}`] = { type: 'string' };
    expect(() =>
      normalizeStructuredOutputSchema({ type: 'object', properties: wide }),
    ).toThrow(/exceeds the .* limit/);
  });

  it('rejects scalar-heavy schemas past the serialized-size cap', () => {
    // A giant enum is only a couple of object nodes but a huge payload; the
    // size cap catches what the node/depth caps cannot.
    const choice = { enum: Array.from({ length: 200_000 }, (_, i) => `v${i}`) };
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: { choice },
      }),
    ).toThrow(/byte size limit/);
  });
});

describe('buildTerminalTool', () => {
  const schema = z.strictObject({ title: z.string(), count: z.number() });

  it('rejects a non-object root schema so provider tool inputs stay valid', () => {
    expect(() => buildTerminalTool(z.array(z.string()), vi.fn())).toThrow(
      /object at the root/,
    );
  });

  it.effect(
    'supports async Zod validation through the canonical tool boundary',
    () =>
      Effect.gen(function* () {
        const capture = makeCapture();
        const tool = buildTerminalTool(
          z.strictObject({
            title: z.string().refine(async (value) => value === 'accepted'),
          }),
          capture,
        );

        expect(yield* tool.call({ title: 'rejected' })).toMatchObject({
          status: 'error',
        });
        expect(yield* tool.call({ title: 'accepted' })).toMatchObject({
          status: 'executed',
        });
      }),
  );

  it.effect(
    'rejects transformed values that cannot cross the JSON boundary',
    () =>
      Effect.gen(function* () {
        const capture = makeCapture();
        const tool = buildTerminalTool(
          z.strictObject({ value: z.string().transform(() => 1n) }),
          capture,
        );

        expect(yield* tool.call({ value: 'one' })).toMatchObject({
          status: 'error',
        });
        expect(capture).not.toHaveBeenCalled();
      }),
  );

  it.effect('accepts only one structured result per run', () =>
    Effect.gen(function* () {
      const capture = makeCapture();
      const tool = buildTerminalTool(schema, capture);

      expect(yield* tool.call({ title: 'First', count: 1 })).toMatchObject({
        status: 'executed',
      });
      expect(yield* tool.call({ title: 'Second', count: 2 })).toMatchObject({
        status: 'error',
      });
      expect(capture).toHaveBeenCalledTimes(1);
    }),
  );
});

// `report_review_issue` takes its input through a normalized structured-output
// schema; the host sink must still receive the finding as the agent sent it.
describe('report_review_issue', () => {
  it.effect('hands the host sink each finding with omitted fields unset', () =>
    Effect.gen(function* () {
      const sink = vi.fn<NonNullable<HostInteractions['reportReviewIssue']>>(
        () => ({ accepted: true }),
      );
      const detach = yield* testDefaultSession().interactions.use({
        reportReviewIssue: sink,
      });
      yield* Effect.addFinalizer(() => Effect.sync(detach));
      const report = {
        file: 'src/x.ts',
        startLine: 5,
        severity: 'critical',
        title: 'Broken loop',
        description: 'Off-by-one in bounds.',
      } as const;

      const result = yield* ReportReviewIssueTool.call(report);

      expect(result.summary).toBe(
        'Reported review issue src/x.ts:5 [critical] Broken loop',
      );
      expect(sink).toHaveBeenCalledExactlyOnceWith({
        ...report,
        endLine: undefined,
        suggestion: undefined,
      });
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
      Effect.scoped,
    ),
  );
});
