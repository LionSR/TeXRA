-- Migration: Add round-level aggregation columns to usage_logs
--
-- Previously, tool-use agents created one row per cycle iteration (N rows per run).
-- Now the client aggregates all cycles into a single row with summed totals.
-- The per-cycle breakdown is preserved in a JSONB `rounds` column.

-- Number of model invocation cycles in this agent run
ALTER TABLE public.usage_logs ADD COLUMN round_count INTEGER;

-- Per-cycle usage breakdown (array of {inputTokens, outputTokens, cost, ...})
ALTER TABLE public.usage_logs ADD COLUMN rounds JSONB;

COMMENT ON COLUMN public.usage_logs.round_count IS 'Number of model invocation rounds in this agent run';
COMMENT ON COLUMN public.usage_logs.rounds IS 'Per-round usage breakdown as JSONB array (preserves cycle-level granularity)';
