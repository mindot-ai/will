# RELEASE — the ritual for cutting a Will release

A release is the end of an **epoch** — a coherent arc of the mind's evolution
(exafference was one; policy reafference another). The ritual exists so every
epoch leaves the same four artifacts behind: a story, a picture, a version, and
an announcement. Follow it in order; each step feeds the next.

## When to cut

**The trigger is an epoch CLOSING — not a date, not a commit count.** Nothing in
this repo prompts you, deliberately: the judgment is semantic and a mechanical
nag would train you to ignore it. What follows is how to make that judgment.

**Cut when all three hold:**

1. **The arc answers its own question.** The epoch's `.TODO` has a story a
   person can read end to end: *the mind can now do X, which it couldn't.*
2. **Something a consumer can actually reach.** Check the new capability is
   exported from `dist/index.d.ts`. Internal-only work — refactors, type splits,
   fixes to an unwired seam — delivers a package consumer *nothing*, however
   much engineering it took.
3. **What's left is genuinely other work**, not the rest of this sentence.

**Do NOT cut when:**

- **The epoch is mid-sentence.** Remaining phases that belong to the same story
  — especially ones blocked on an external party — mean releasing a half-answered
  question and needing another release the moment it resolves.
- **Only internal surfaces moved.** See (2). A `feat:` commit is not evidence;
  check the export surface, not the prefix.
- **You're cutting to move code somewhere.** Workspace consumers (backend) read
  the *committed* `dist/` via the submodule pointer, not npm. That's a pointer
  bump, not a release.

**Why the bar is this high.** The ritual is expensive — graph, story, publish
fan-out, LinkedIn — and it is a *signal*. Spend it on internal refinement and
you teach people a Will release doesn't mean much. Every tag so far has meant
something; keep it that way.

### Checking drift

Drift is not a trigger, but it is worth knowing. Nothing surfaces it for you:

```bash
git log --oneline "$( git describe --tags --abbrev=0 )"..HEAD
```

Compare against `package.json` (which stays at the last released version until
the release PR bumps it). Accumulation is normal and healthy — the tail of an
epoch often sits on main for a while waiting for the arc to close.

### The patch clause

`patch` exists in the convention and has **never fired** — every tag is a minor
(`v0.3.0` … `v0.7.0`), because we ship epochs. It is for a defect in *released,
publicly reachable* behaviour that can't wait for the next epoch. If the broken
thing isn't exported, it isn't a patch; it's just a fix riding the next release.

### Worked example (2026-07-28)

Ten commits sat on main after `v0.7.0` — P5's taxonomy split, the conformance
pack, ENVELOPE_NARROWING P0, the release tooling. Held, not cut, on all three
tests: P5 changed no public surface (the policy seam has no exported
`setArbiter`, so no consumer could use any of it); the epoch was mid-sentence
with P6 and ENVELOPE_NARROWING P1 both waiting on an upstream answer; and the
whole tail will ride the release that follows, whichever of those lands first.

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
Pre-1.0 convention: **minor per epoch**, patch for fixes (see *When to cut* —
the patch clause has never fired). A public-surface break would force the
discussion; additive never does.

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
