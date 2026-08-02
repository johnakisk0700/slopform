# Active engineering TODO

This is the active backlog, not implementation history. Completed items leave
this file when their code, tests and owning documentation land together.

## P0 — before real WhatsApp traffic

- [x] **Serialize inbound materialization per conversation across worker
      replicas.** Replace the current per-process `feedback-ingress` concurrency
      assumption with a deployment-wide per-conversation lease or equivalent
      fence. Preserve parallelism between different conversations; global FIFO
      would let one participant block everybody. Acceptance: simultaneous
      messages for one conversation materialize in durable PostgreSQL
      `ingressOrder` (insert) order under two workers, while different
      conversations still progress concurrently.

- [x] **Recover a lost extraction intent from durable state.** Add startup and
      periodic reconciliation for an open bot conversation whose latest
      participant sequence is beyond `extraction.cursorSeq` but has no viable
      extraction or parked-retry job. Re-enqueue with a stable recovery identity
      and retain the existing conversation lease, cursor checks and result/outbox
      deduplication. Redis AOF is useful persistence; it is not the business
      source of truth.

- [ ] **Run a restart-mid-burst acceptance test.** Stop and restart the worker
      during the quiet window, during a provider call, and after materialization
      but before extraction settlement. Assert that every durable inbound is
      eventually covered, per-conversation order survives, no answer/outbound is
      duplicated, and the run reaches the same terminal state as an uninterrupted
      control.

## P1 — rehearsal realism and capacity

- [ ] **Split the rehearsal into named test shapes instead of asking one burst to
      prove everything.**

  - `mechanism-burst`: the current deterministic, intentionally aggressive
    scripted senders; proves ingress, queues, batching, retries, recovery and
    idempotency under pressure.
  - `closed-loop-guests`: Grok and Composer alternate character sheets, wait for
    the bot's actual reply, then answer with a bounded human-like delay. This
    proves conversational behaviour and must report model substitutions or
    unavailable guest agents as missing coverage.
  - `capacity-rehearsal`: five to six concurrent tables with measured arrival
    distribution; reports queue age, bot-response p50/p95/max, provider RPM/TPM,
    errors and duplicate outbound count.

  Keep the scripted corpus. Making every persona model-driven would turn
  mechanism regressions into nondeterministic simulator arguments and make the
  expensive test less reproducible, not more realistic.

- [ ] **Measure a higher provider start rate before changing the production
      default.** Compare the previous `30 concurrent / 30 starts per minute`
      treatment with `30 / 60` on the same seeded corpus and model controls.
      Raising the concurrency ceiling alone cannot help while the rolling start
      gate is saturated. The Terra production rehearsal peaked at 166,983
      reported tokens in one rolling 60-second completion window against the
      measured 500k TPM allowance; that makes 60 a credible experiment, not a
      proven safe default. Promote it only if TPM headroom, provider errors,
      queue age and reply latency all remain acceptable.

- [ ] **Reduce or prioritize model-call fan-out.** The Terra rehearsal used 53
      extraction calls, 53 attention calls and 31 reply calls for 87 inbound
      messages. Measure conditional/combined attention classification and reserve
      provider capacity for participant-facing turns ahead of summaries and
      assistant background traffic. Fewer calls are preferable to hiding the
      same amplification behind a larger semaphore.
