# RELEASE — the ritual for cutting a Will release

A release is the end of an **epoch** — a coherent arc of the mind's evolution
(exafference was one; policy reafference another). The ritual exists so every
epoch leaves the same four artifacts behind: a story, a picture, a version, and
an announcement. Follow it in order; each step feeds the next.

## 0 · Pre-flight

- Full suite green (`bun run test`), typecheck clean, **replay-equivalence
  green** — determinism is a release gate, not a nice-to-have.
- `dist/` is committed and current. Feature PRs carry their own dist rebuild
  (`bun run build`); if the epoch's PRs didn't, land a `chore: rebuild dist`
  catch-up first. Workspace consumers (backend) read the *committed* dist —
  npm is safe regardless (`prepublishOnly` rebuilds in CI), the workspace is not.

## 1 · The picture

Every epoch gets a graph. Add a declarative spec to `docs/graphs/generate.ts`
(the shared `lib.ts` keeps it on-style by construction — same palette, a violet
node is always memory, green always agency) and re-emit:

```bash
bun docs/graphs/generate.ts
```

Then reference it from the epoch's design doc — the `.TODO/<EPOCH>.md` is the
document of record, and the graph is its picture:

```markdown
> **The picture:** `docs/graphs/<epoch>-loop.svg` — the whole arc in one diagram.
```

## 2 · The story

Turn `## Unreleased` in `CHANGELOG.md` into `## X.Y.Z — <date> · <theme>`.

The theme is **mind-first — about how the mind evolved**, never about the
mechanism: *"the mind knows its own echo"*, *"the mind learns may from can"*.
An intro paragraph names the epoch's idea in plain language; bold-led bullets
tell what the Will can now do that it couldn't, with the mechanism woven
underneath; a closing *"Throughout:"* paragraph states the quiet-path guarantee
(byte-identical without the feature; determinism, replay, snapshot/restore hold).

## 3 · The version

Bump `package.json` — it is the version that ships (`VERSION` is unused).
Pre-1.0 convention: **minor per epoch**, patch for fixes. A public-surface break
would force the discussion; additive never does.

## 4 · The release PR

Branch `release/X.Y.Z` touching **exactly two files** — `CHANGELOG.md` and
`package.json` — so release archaeology stays trivial. PR, green CI, merge.

## 5 · The publish (the human gate)

Create the GitHub Release `vX.Y.Z` targeting main, notes = the CHANGELOG
section. Publishing it fans out automatically:

- `publish.yml` → npm trusted-publish of `@mindot/will` (OIDC, no stored token);
- `announce-discord.yml` → posts the release to the Mindot Discord
  (needs the `DISCORD_WEBHOOK_URL` repo secret; skips green when absent).

## 6 · After the publish

- **Mindbase pointer bump:** `chore: bump will to <sha> (vX.Y.Z release)` in the
  parent repo (the sha *after* any dist catch-up, so the pointer carries the
  fresh dist the backend reads).
- **The post:** draft the LinkedIn/social piece from the CHANGELOG story —
  mind-first narrative, not a feature list; the epoch's graph is the visual.

## Why a ritual

The engine's claim is that a mind's growth should be legible and replayable.
Its releases should hold the same bar: every epoch leaves a story a person can
read, a picture a person can point at, a version a machine can pin, and an
announcement the community actually hears — with the publish itself gated on
one deliberate human click.
