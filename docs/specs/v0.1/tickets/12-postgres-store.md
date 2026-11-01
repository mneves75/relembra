# 12: Postgres store over a host SqlClient

**What to build:** A host passes its own SQL client; relembra stores memories in Postgres with the same behaviour as SQLite.

**Blocked by:** 11

**Status:** ready-for-agent

- [ ] The conformance suite passes on Postgres 17 in a throwaway container
- [ ] Mutations take a store-lock row before reading mutable state; all checks and writes use one transaction-bound client (IMPLEMENTATION-PLAN §4.4)
- [ ] Retryable SQLSTATEs 40001/40P01 are retried with a bound; an ambiguous commit is resolved by op id
- [ ] Database time for acceptance and retention; caller time kept as provenance
- [ ] Races tested: duplicate op ids, conflicting supersedes, redaction against summary creation
- [ ] Migration rules of §4.5 hold, with golden fixtures
