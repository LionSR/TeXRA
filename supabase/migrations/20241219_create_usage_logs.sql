-- Migration: Create usage_logs table for API usage tracking
--
-- This table stores API usage data for analytics and future rate limiting.
-- Each row represents a single API call made by a user.

-- Create usage_logs table
CREATE TABLE IF NOT EXISTS public.usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- User reference
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Timing
    timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Model/Provider info
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    agent_name TEXT,

    -- Token counts
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER,
    reasoning_tokens INTEGER,

    -- Cost and timing
    cost DECIMAL(10, 6) NOT NULL DEFAULT 0,
    response_time_ms INTEGER,

    -- Metadata
    used_relay BOOLEAN DEFAULT FALSE,
    stream_id TEXT,
    extension_version TEXT,
    batch_id UUID,

    -- Constraints
    CONSTRAINT positive_tokens CHECK (input_tokens >= 0 AND output_tokens >= 0),
    CONSTRAINT positive_cost CHECK (cost >= 0)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON public.usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_timestamp ON public.usage_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_timestamp ON public.usage_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON public.usage_logs(model);
CREATE INDEX IF NOT EXISTS idx_usage_logs_provider ON public.usage_logs(provider);
CREATE INDEX IF NOT EXISTS idx_usage_logs_batch_id ON public.usage_logs(batch_id);

-- Index for rate limiting queries (daily/monthly aggregates)
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_date
ON public.usage_logs(user_id, DATE(timestamp));

-- Enable Row Level Security
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can only read their own usage logs
CREATE POLICY "Users can read own usage logs"
ON public.usage_logs FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Inserts are handled by the edge function with service role key
-- (No direct insert policy for users - they go through the log-usage endpoint)

-- Grant permissions
GRANT SELECT ON public.usage_logs TO authenticated;

-- Comment on table
COMMENT ON TABLE public.usage_logs IS 'API usage logs for analytics and rate limiting';
COMMENT ON COLUMN public.usage_logs.user_id IS 'User who made the API call';
COMMENT ON COLUMN public.usage_logs.timestamp IS 'When the API call completed (client time)';
COMMENT ON COLUMN public.usage_logs.model IS 'Model identifier (e.g., claude-sonnet-4-20250514)';
COMMENT ON COLUMN public.usage_logs.provider IS 'API provider (anthropic, openai, google, etc.)';
COMMENT ON COLUMN public.usage_logs.agent_name IS 'Agent that initiated the request';
COMMENT ON COLUMN public.usage_logs.input_tokens IS 'Number of input tokens consumed';
COMMENT ON COLUMN public.usage_logs.output_tokens IS 'Number of output tokens generated';
COMMENT ON COLUMN public.usage_logs.cached_input_tokens IS 'Tokens served from provider cache';
COMMENT ON COLUMN public.usage_logs.reasoning_tokens IS 'Tokens used for reasoning (o1, etc.)';
COMMENT ON COLUMN public.usage_logs.cost IS 'Computed cost in USD';
COMMENT ON COLUMN public.usage_logs.response_time_ms IS 'Response time in milliseconds';
COMMENT ON COLUMN public.usage_logs.used_relay IS 'Whether server-side API keys were used';
COMMENT ON COLUMN public.usage_logs.stream_id IS 'Session identifier for grouping requests';
COMMENT ON COLUMN public.usage_logs.extension_version IS 'Client extension version';
COMMENT ON COLUMN public.usage_logs.batch_id IS 'Batch ID for deduplication';
