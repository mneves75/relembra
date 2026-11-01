# Contributing

Bug reports, questions and pull requests are welcome. For a vulnerability, follow
[SECURITY.md](SECURITY.md) instead of opening an issue.

## Set up

You need Bun 1.4 or later, Node 24.14 or later, and Docker for the Postgres tests. Building the
CLI needs a Bun with `--aot` (canary today).

```sh
bun install              # also enables the pre-push hook in .githooks/
bun run build:cli        # the CLI tests run the binary
scripts/with-postgres.sh bun run test:all
bun run test:node
bun run typecheck && bun run lint
```

## Make a change

- Open an issue first for anything larger than a small fix, so the design can be agreed before
  the code.
- Work on a branch and open a pull request against `main`. Hosted CI runs on every pull request;
  run `scripts/ci.sh`, the whole gate, before asking for review.
- Write the test first and show it failing. Every negative assertion needs a positive control, so
  a check that can never fail cannot pass.
- The library has zero runtime dependencies and runs on both Node and Bun: use only APIs both
  provide.
- Write everything from scratch: no code copied from other projects.
- Never commit secrets, personal memory content, transcripts, real user queries or local paths.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and say why
  the change was made and how it was proved. Fill in the pull request template the same way.

[AGENTS.md](AGENTS.md) holds the full rules and checks; coding agents read it first.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
