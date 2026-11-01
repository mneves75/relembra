# Ranking algorithm (clean-room specification)

This document is the only source for relembra's tokenizer and ranking. It is written from
standard information-retrieval practice (Okapi BM25, Unicode normalisation, suffix stripping).
Implementers must not consult any other project's source code.

## 1. Normalise

1. Unicode NFKD.
2. Remove combining marks (general category `Mn`). This folds accents: `memória` becomes
   `memoria`, `ação` becomes `acao`.
3. Lower-case with `toLowerCase()` (locale-independent).

## 2. Tokenise

- Split on runs of characters that are neither letters nor digits (`/[^\p{L}\p{N}]+/u`).
- Drop empty tokens and single-character tokens, except digits (`7` is kept). A digit here is a
  decimal digit (`\p{Nd}`).
- `#3274` yields `3274`. `snake_case` yields `snake` and `case`. `v0.1` yields `v0` and `1`.

## 3. Stop words

Removed from documents and queries:

- Portuguese: `a o e de da do das dos em no na nos nas um uma uns umas para por com sem que se
  ao aos as os ou mas como mais muito ja nao sim seu sua seus suas ele ela eles elas isso esse
  essa este esta foi ser sao tem ter pra pro pela pelo pelas pelos`
- English: `the a an and or of to in on at for with without is are was were be been it its this
  that these those by from as not no yes do does did`

If a query has no tokens left after removal, the query keeps its stop words instead. For that
query the documents keep their stop words too, so `N`, `df`, `|d|` and `avgdl` are computed over
tokens with stop words; otherwise a stop word could never match.

## 4. Stem (light, plural-oriented)

Applied to tokens of 4 characters or more, after folding. Apply the first rule that matches,
once:

| Suffix | Replacement | Example |
|---|---|---|
| `ies` | `y` | `queries` → `query` |
| `oes`, `aes` | `ao` | `migracoes` → `migracao`, `paes` → `pao` |
| `ais` | `al` | `canais` → `canal` |
| `eis` | `el` | `papeis` → `papel` |
| `ns` | `m` | `itens` → `item` |
| `res`, `ses`, `zes` | drop the final `es` | `servidores` → `servidor` |
| `s`, if the token does not end in `ss`, `us` or `is` | drop the final `s` | `agents` → `agent`, `notas` → `nota` |

Each token yields its exact form and its stem; the two can be equal.

## 5. Score (BM25)

Over the candidate set, which is only the memories the principal may read and that are live (not
retracted, redacted or superseded):

- `N` is the number of candidates and `avgdl` their mean length in tokens.
- For a query term `t`: `df(t)` is the number of candidates containing `t`, and
  `idf(t) = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))`.
- For a candidate `d` of length `|d|` with term frequency `f(t,d)`:
  `score(t,d) = idf(t) · f · (k1 + 1) / (f + k1 · (1 − b + b · |d| / avgdl))`, with `k1 = 1.2` and
  `b = 0.75`.
- Each query token contributes its exact-form score with weight 1.0, or, if the exact form is
  absent from `d`, its stem score with weight 0.5. The total is the sum over distinct query tokens.
- At most 32 distinct query tokens are scored: the first 32 in query order, counted after §3
  (stop words removed, or kept by the fallback) and after duplicates are dropped. Later tokens
  are ignored. The cap bounds the work one query can cause.
- Candidates scoring 0 are not returned.
- Ties are broken by newer first (higher store sequence), then by memory id.
  A memory's store sequence is the seq of the event that produced its current revision. Memory ids
  are compared ascending, by UTF-16 code unit (not by locale).
- `|d|` and `f(t,d)` count exact-form tokens after stop-word removal. The stem score uses the
  stem counterparts: `f` is the number of tokens in `d` whose stem equals the query token's stem,
  and `df` the number of candidates holding such a token.

## 6. Properties the tests must pin

- Accent folding: a query `memoria` finds `memória`, and the reverse.
- Plural folding: `agentes` finds `agente`; `migrações` finds `migração`.
- An exact match outranks a stem-only match when the other factors are equal.
- Scope: a memory outside the principal's readable scopes never contributes to `N`, `df` or the
  results.
- Determinism: the same store and query always give the same order.
