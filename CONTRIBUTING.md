# Contributing to Will

Thanks for your interest! Will is early and moving fast — contributions are welcome,
and a little coordination up front saves everyone time.

## Ground rules

- **Discuss before building.** For anything beyond a small fix, open an issue (or a
  Discussion) first so we can agree on the approach before you invest time.
- **Determinism is sacred.** Will's core guarantee is that the same seed + the same
  inputs reproduce the same mind. Changes that introduce nondeterminism into the tick
  path (unseeded randomness, wall-clock reads inside cognition, iteration-order
  dependence) will be asked to rework. `Date.now()` belongs at the edges, not in engines.
- **Match the house style.** The codebase uses a consistent idiom (spacing inside
  parens, aligned imports, comment banners). Copy the style of the file you're editing.

## Dev setup

```bash
git clone <repo-url> && cd will
bun install
bun run typecheck   # tsc --noEmit
bun test            # the engine test suite
bun run build       # tsup → dist/
```

Bun ≥ 1.1 is required (the engine targets Bun as its primary runtime).

## Running a Will locally

```bash
bun run examples/hello-will.ts     # no API key needed (deterministic mock executive)
```

See [`examples/`](examples/) for the persistence and real-LLM variants.

## Pull requests

- Keep PRs focused — one concern per PR.
- Include tests for engine behavior changes. The suite must stay green.
- Describe *why*, not just *what*, in the PR body.
- New engines/faculties: open an issue first — the engine roster is deliberately curated.

## Reporting bugs

Use the bug-report issue template. The single most useful thing you can include is a
**minimal reproduction** — ideally a small script against the public API, plus your
Bun version and platform.

## Security issues

Please do **not** open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
