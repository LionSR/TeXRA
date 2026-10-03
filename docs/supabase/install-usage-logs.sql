-- Anonymous install usage: one append-only row per usage entry (one model
-- call). Additive; apply BEFORE deploying log-usage-v2. Service role only.
CREATE TABLE public.install_usage_logs (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  install_id          uuid        NOT NULL,
  batch_id            uuid        NOT NULL,
  entry_index         integer     NOT NULL,
  logged_at           timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  model               text        NOT NULL,
  provider            text        NOT NULL,
  agent_name          text,
  agent_category      text,
  usage_route         text,
  input_tokens        integer     NOT NULL,
  output_tokens       integer     NOT NULL,
  cached_input_tokens integer,
  reasoning_tokens    integer,
  cost                numeric     NOT NULL,
  response_time_ms    integer,
  stream_id           text,
  extension_version   text,
  editor_type         text,
  -- A retried batch conflicts here and inserts nothing.
  UNIQUE (install_id, batch_id, entry_index)
);

CREATE INDEX install_usage_logs_install_time_idx
  ON public.install_usage_logs (install_id, logged_at);

-- RLS on with no policies: only the service role (which bypasses RLS) reads or
-- writes. No FK to auth.users: an install has no account.
ALTER TABLE public.install_usage_logs ENABLE ROW LEVEL SECURITY;
