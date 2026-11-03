# deepseek/deepseek-flash, 2026-11-03

Harness 0.1.0 from the packed tarball at `5bdefcf7b3`, Node v26.12.1.
Spend reported by the runs: $0.0000.

| Scenario     | Result | Runs | Scripts (failed) | Tokens in/out | Cost (USD) | Seconds |
| ------------ | ------ | ---- | ---------------- | ------------- | ---------- | ------- |
| codemode     | fail   | 1    | 0 (0)            | 0/0           | 0.0000     | 1       |
| plugin       | fail   | 1    | 0 (0)            | 0/0           | 0.0000     | 1       |
| crash-resume | fail   | 1    | 0 (0)            | 0/0           | 0.0000     | 1       |

## codemode

- FAIL: run completed (Error executing agent draft_reviewer: HTTP 402 Payment Required – 402 Insufficient Balance (request_id: 03d2755b-ffb1-47db-88e3-76938cdb243c))
- FAIL: a script finished ([])
- FAIL: the module called the plugin tool
- FAIL: two self() rounds completed (0 of 0)
- FAIL: an executions SQL query succeeded
- FAIL: the script returned every section title
- FAIL: the returned count matches the finished children ({"completed":0})

## plugin

- FAIL: run completed (Error executing agent note_taker: HTTP 402 Payment Required – 402 Insufficient Balance (request_id: 02abe2f1-53cf-46a9-90fc-d7c407c9667a))
- FAIL: a script imported the notes module ([])
- FAIL: note_add ran from a script
- FAIL: both notes are versioned facts of the plugin ([])
- FAIL: the script returned both notes

## crash-resume

- FAIL: the script reached a committed self() result and a pending sign-off (self ended: false, sign-off started: false, crash process exited first, its run failed: Error executing agent two_round_reviewer: HTTP 402 Payment Required – 402 Insufficient Balance (request_id: ce91a0e5-c8f6-4a9e-8946-a8fabe19a273))
