# Candidate protocol, version 1

A candidate is one command. The scorer (`eval/score.ts`) starts it as a subprocess and talks to
it in JSON lines over stdin and stdout. No candidate gets an in-process path. The types in
`eval/protocol.ts` are this document in code, and the scorer's validators enforce it.

## Transport

- **Framing.** stdin carries one request per line. stdout carries one response per line, in
  request order, flushed after each line. Only responses go to stdout; diagnostics go to stderr,
  of which the scorer keeps the last 16,384 characters (UTF-16 code units) and counts the bytes
  as written.
- **One request at a time.** The scorer waits for each response before sending the next request.
- **One response per request.** A line on stdout while no request waits for one (before the first
  request, or a second line for one request) breaks the stream: the scorer kills the candidate at
  once, as it does for a line over the limit, and never queues the line. The request the line
  followed fails as `unsolicited`, and the line is inspected for leaks against that request's
  principal; the next request restarts the candidate. A line that arrives only after the next
  request was sent is that request's response and fails it. Everything else on stdout outside
  the responses (lines after that one, output while the corpus loads or after `stop`, an
  unterminated tail at exit, up to the line limit) is failed and inspected the same way, by text.
  Output dropped past the limit fails with a reason that says it was not leak-checked.
- **End of session.** The scorer sends `stop`, then closes stdin. The candidate answers `stop` and
  exits 0. A candidate still running one second after stdin closes is killed.
- **Process group.** The scorer starts the candidate in its own process group and kills the whole
  group, so anything the candidate starts is stopped with it.

### Limits

| Limit                                                           | Default                                        | Scorer flag        |
| --------------------------------------------------------------- | ---------------------------------------------- | ------------------ |
| Per-request deadline (`reset`, `find`, `brief`, `wake`, `stop`) | 5,000 ms                                       | `--deadline-ms`    |
| Per-request deadline (`note`)                                   | the deadline plus 1 ms per memory in the batch | —                  |
| Response line                                                   | 1 MiB                                          | `--max-line-bytes` |
| `find` results                                                  | the request's `limit` (10)                     | —                  |
| `brief` and `wake` text                                         | the request's `budgetBytes`, in UTF-8 bytes    | —                  |

## Envelope

Request:

```json
{ "v": 1, "id": "r7", "cmd": "find", "args": {} }
```

- `v` is the protocol version.
- `id` is a string the scorer chooses.
- `args` is the command's argument object.

Success:

```json
{ "id": "r7", "ok": true, "result": {} }
```

Failure:

```json
{ "id": "r7", "ok": false, "error": { "code": "bad_request", "message": "query is empty" } }
```

A response holds exactly these fields: `id`, `ok` and `result`, or `id`, `ok` and `error` with
`code` and `message`. Results hold exactly the fields their command's schema lists below. Any
other field, at any depth, fails the request, and so does a key written twice in one object
(compared decoded); the response is still inspected for leaks, every value of a repeated key
included.

The response `id` must be the request's `id`, compared as strings: `7`, `true` and `7.0` do not
answer `"7"`. The error codes are `unsupported`, `bad_request` and `internal`; the scorer treats
every error as a failed request, so a candidate that does not support a surface fails the
questions that use it.

## Shared definitions

**Memory id.** An opaque string the candidate assigns. It must match `^[A-Za-z0-9_-]{8,128}$`.
The shape is restricted so the scorer can find an id inside rendered text without false
matches: it looks for the id bounded by characters outside `[A-Za-z0-9_-]`. Ids carry no
meaning, and the scorer never parses one.

**Principal.** Every read and write names its principal explicitly. The shape mirrors
`Principal` in `src/model.ts`, plus `pinnable` from the implementation plan (§4.1):

```json
{
  "type": "object",
  "required": ["id", "readable", "writable", "promotable", "trustCeiling", "pinnable"],
  "properties": {
    "id": { "type": "string" },
    "readable": { "type": "array", "items": { "type": "string" } },
    "writable": { "type": "array", "items": { "type": "string" } },
    "promotable": { "type": "array", "items": { "type": "string" } },
    "trustCeiling": { "enum": ["owner", "agent", "untrusted"] },
    "pinnable": { "type": "boolean" }
  }
}
```

A candidate must serve a principal only memories from its `readable` scopes, on every surface.

**Trust.** `owner`, `agent` or `untrusted`, as in `GLOSSARY.md`.

**Rendering.** `brief` and `wake` text is lines separated by LF. Every line is empty or exactly
one of these forms, from its first character to its last; any other line fails the request:

```
<brief>                                                    frame open (brief only)
</brief>                                                   frame close (brief only)
<wake>                                                     frame open (wake only)
</wake>                                                    frame close (wake only)
<index id="…"/>                                            an id-only index entry
<memory id="…" scope="…" rev="…" at="…" trust="…">text</memory>   one memory
```

- A memory element has exactly those five attributes, each once, in any order, separated by
  one space; its content is the memory's text.
- Text and attribute values escape `&`, `<`, `>` and `"` as `&amp;`, `&lt;`, `&gt;` and
  `&quot;`, and each line separator (LF, CR, U+0085, U+2028, U+2029) as a decimal reference
  such as `&#10;`, so every memory stays on one line. Escaped markup inside a memory's text,
  such as `&lt;memory`, is text.
- Frames are optional. Headers, decorations and free text are not protocol lines: memory text
  appears only inside its own memory element.

## Commands

### `reset`

Discards all state. It is always the first request of a session.

- args: `{}`
- result:

```json
{
  "type": "object",
  "required": ["protocol", "name", "version"],
  "additionalProperties": false,
  "properties": {
    "protocol": { "const": 1 },
    "name": { "type": "string", "minLength": 1, "maxLength": 100 },
    "version": { "type": "string", "minLength": 1, "maxLength": 100 }
  }
}
```

The scorer records `name` and `version` in its report, so a baseline is always named. Like every
string of the `reset` and `note` results, they are leak-checked: any loaded memory's text in them,
live or not, is a leak, since no principal's read reaches them. Both are
printed to the terminal and into Markdown reports, so each must be a single-line label: no
control character (ESC among them), format character, line or paragraph separator, lone
surrogate, private-use, unassigned or default-ignorable code point, no `|`, and no leading or
trailing whitespace. A `reset` that breaks this fails with a fixed message that never repeats the
value, so the candidate is never named; the reports also escape Markdown markup in both.

### `note`

Bulk-loads memories from the corpus. Version 1 has no separate retract, redact or supersede
command, so each item states what must have happened to it once the batch is loaded:

- `state: "retracted"`: note it, then retract it.
- `state: "redacted"`: note it, then redact it.
- `supersedes`: the id the candidate returned, in an earlier batch, for the memory this one
  supersedes.

The scorer loads the corpus in batches. Memories that supersede another come in a later batch
than the memory they supersede. Each batch has one writer principal, whose `trustCeiling` is
the batch's trust and which is `pinnable` when the batch pins anything.

Each item's `at` is the epoch-millisecond time the corpus gives it. A candidate injects it as its
clock, so the same corpus always gives the same store.

- args:

```json
{
  "type": "object",
  "required": ["principal", "memories"],
  "properties": {
    "principal": { "$ref": "#principal" },
    "memories": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["scope", "text", "at", "trust", "pinned", "state"],
        "properties": {
          "scope": { "type": "string" },
          "text": { "type": "string" },
          "at": { "type": "integer" },
          "trust": { "enum": ["owner", "agent", "untrusted"] },
          "pinned": { "type": "boolean" },
          "state": { "enum": ["live", "retracted", "redacted"] },
          "supersedes": { "type": "string" }
        }
      }
    }
  }
}
```

- result: one id per memory, in order. The ids must be distinct within the session.

```json
{
  "type": "object",
  "required": ["ids"],
  "additionalProperties": false,
  "properties": {
    "ids": { "type": "array", "items": { "type": "string", "pattern": "^[A-Za-z0-9_-]{8,128}$" } }
  }
}
```

### `find`

A ranked search over the memories the principal may read: live ones only, best first.

- args:

```json
{
  "type": "object",
  "required": ["principal", "query", "limit"],
  "properties": {
    "principal": { "$ref": "#principal" },
    "query": { "type": "string" },
    "limit": { "type": "integer", "minimum": 1 }
  }
}
```

- result: at most `limit` results with distinct ids, each an id this session's `note` returned.
  `trust` is the memory's trust label; a label above it fails the request.

```json
{
  "type": "object",
  "required": ["results"],
  "additionalProperties": false,
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "text", "trust"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string" },
          "text": { "type": "string" },
          "trust": { "enum": ["owner", "agent", "untrusted"] }
        }
      }
    }
  }
}
```

### `brief`

A bounded block of memories for one topic, rendered as above.

- args:

```json
{
  "type": "object",
  "required": ["principal", "topic", "budgetBytes"],
  "properties": {
    "principal": { "$ref": "#principal" },
    "topic": { "type": "string" },
    "budgetBytes": { "type": "integer", "minimum": 1 }
  }
}
```

- result: `text` of at most `budgetBytes` UTF-8 bytes. An empty brief is `""`.

```json
{
  "type": "object",
  "required": ["text"],
  "additionalProperties": false,
  "properties": { "text": { "type": "string" } }
}
```

### `wake`

The session-start block for a principal working in `scope`, which is one of its readable scopes.

- args:

```json
{
  "type": "object",
  "required": ["principal", "scope", "budgetBytes"],
  "properties": {
    "principal": { "$ref": "#principal" },
    "scope": { "type": "string" },
    "budgetBytes": { "type": "integer", "minimum": 1 }
  }
}
```

- result:
  - `text`: at most `budgetBytes` UTF-8 bytes.
  - `pinned`: the ids rendered in the wake's pinned section, distinct and known. The plan's
    rendering (§4.2) has no pinned marker, so the section is reported here.

```json
{
  "type": "object",
  "required": ["text", "pinned"],
  "additionalProperties": false,
  "properties": {
    "text": { "type": "string" },
    "pinned": { "type": "array", "items": { "type": "string" } }
  }
}
```

### `stop`

Ends the session. The candidate answers, then exits 0. A `stop` that fails (a malformed answer,
none within the deadline) fails the run like any other request.

- args: `{}`
- result: `{}`

## What the scorer does with responses

A response fails its request when any of these holds:

- it is late;
- its line is too long;
- a line arrived before it that no request asked for (`unsolicited`);
- it is not JSON;
- it answers another id;
- it has no result object, or it is an error;
- its envelope, error, result or a `find` result entry holds a field this document does not
  define (every schema here is closed);
- an object in it holds one key twice;
- its result breaks the command's schema or limits;
- it repeats an id, or names an id this session never noted;
- a `find` result's `text` is not its memory's text, raw or escaped;
- a `brief` or `wake` line is neither empty nor one of the line forms under "Rendering" (an
  indented, wrapped, entity-encoded or decorated line, a header, an index carrying text);
- a `brief` or `wake` index line names an id this session never noted;
- a `brief` or `wake` memory element is malformed, names an id this session
  never noted, repeats an id already rendered in that text, or does not match its memory: `scope`
  must be the memory's scope, `rev` its revision (every memory the scorer loads is at revision
  1), `at` its `at` as an ISO 8601 UTC time (`Date.prototype.toISOString`), `trust` at or below
  its trust, and the content exactly its escaped text.

The run never stops for a failure, and a failed request scores nothing.

The first five of those failures, and a candidate that exits, leave the stream untrustworthy. The
scorer then kills the candidate and starts a new one. It sends `reset` and reloads the corpus,
and gets new ids, which it uses from then on. After three restarts, every remaining request fails
without being sent.

Every `find`, `brief` and `wake` response is inspected for leaks before it is validated, failed
or not. That includes results past the limit and a non-JSON line, which is inspected as raw text.
`eval/README.md` defines the leak check and the metrics.

## Example

```
> {"v":1,"id":"r1","cmd":"reset","args":{}}
< {"id":"r1","ok":true,"result":{"protocol":1,"name":"example","version":"0.0.1"}}
> {"v":1,"id":"r2","cmd":"note","args":{"principal":{"id":"loader-owner","readable":[],"writable":["alpha"],"promotable":[],"trustCeiling":"owner","pinnable":false},"memories":[{"scope":"alpha","text":"The cache keeps entries for 5 minutes.","at":1767225600000,"trust":"owner","pinned":false,"state":"live"}]}}
< {"id":"r2","ok":true,"result":{"ids":["mem-0001"]}}
> {"v":1,"id":"r3","cmd":"find","args":{"principal":{"id":"reader","readable":["beta"],"writable":[],"promotable":[],"trustCeiling":"agent","pinnable":false},"query":"cache","limit":10}}
< {"id":"r3","ok":true,"result":{"results":[]}}
> {"v":1,"id":"r4","cmd":"stop","args":{}}
< {"id":"r4","ok":true,"result":{}}
```
