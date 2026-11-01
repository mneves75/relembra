# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `docs/specs/`.

## Conventions

- One feature per directory: `docs/specs/<feature-slug>/`
- The spec is `docs/specs/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `docs/specs/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `docs/specs/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `docs/specs/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `docs/specs/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `docs/specs/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## Repository adjustments

- `docs/specs/` replaces upstream's `.scratch/` and is tracked in git. Ticket files are
  deleted in the commit that finishes the feature; the spec stays.
- There is no triage skill here, so tickets carry no triage `Status:` roles. Wayfinder tickets use
  `Status: open | claimed | resolved`.
- When an effort has both wayfinder tickets and implementation tickets, the wayfinder ones stay in
  `docs/specs/<effort>/issues/` and the `to-tickets` output goes to `docs/specs/<effort>/tickets/`,
  so the two numberings never collide.
- Research findings are written to `docs/specs/<effort>/research/NN-<slug>.md` on the working
  branch, not on throwaway `research/*` branches: parallel agents share one checkout.
