# 13: pi-durable integration (default)

**What to build:** A pi-durable 1.4.0 Harness gets memory tools and a wake section from relembra, safe across crashes.

**Blocked by:** 11

**Status:** done, pending review (the `latest` CI probe is configured but has not run: hosted CI is blocked by billing)

- [x] Peer dependency `@earendil-works/pi-durable` exactly `1.4.0`; a CI probe runs against `latest` without changing the claim
- [x] Tools `memory_note`, `memory_find`, `memory_brief` and a wake section; write tools are `replay: "safe"`, with op ids from the §4.3 tuple hash over host namespace, conversationId, taskId and callId
- [x] Crash test on pi-durable's SQLite storage: killed after the memory commit and before the journal ack, the reopened run finds exactly one memory with the same id and timestamp; without op-id enforcement the control finds two
- [x] One owner per pi-durable storage is documented; takeover works only with a host fencing epoch: a paused writer resuming after the epoch advanced commits nothing, the current writer commits
- [x] Docs state that pi-durable's SQLite schema v2 upgrade is irreversible
