# Field notes — failover behaviors

Observed while routing a mixed prompt workload across four providers.

## Soft rate limits
- Usually 429 with `retry-after` in seconds.
- Policy: timed cooldown with exponential backoff, then automatic re-entry.

## Hard quota exhaustion
- Body contains `insufficient_quota` / `RESOURCE_EXHAUSTED`.
- Policy: long cooldown; the chain continues without asking the user.

## Mid-stream drops
| Provider | Signature | Recovery |
| --- | --- | --- |
| A | connection reset | resume with next model |
| B | stalled SSE | idle timeout → handoff |

> The user never sees the machinery — just a quiet divider in the thread.
