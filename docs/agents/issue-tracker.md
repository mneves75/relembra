# Issue tracker: Local Markdown

Specs and tickets for this repo live as markdown files in `docs/specs/`, tracked in git.

## Conventions

- One feature per directory: `docs/specs/<feature-slug>/`
- The spec is `docs/specs/<feature-slug>/spec.md`, with a `Status:` line near the top
- Implementation tickets are one file per ticket at `docs/specs/<feature-slug>/tickets/<NN>-<slug>.md`,
  numbered from `01`, never a single combined tickets file. Each carries `**Blocked by:**` and
  `**Status:**` lines near the top
- Ticket files are deleted in the commit that finishes the feature; the spec stays, its status set
  to shipped
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `docs/specs/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.
