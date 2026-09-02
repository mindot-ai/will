# STANDING — what a document in this folder may be cited for

`.TODO/` is the development record of a mind: forty-four documents, the oldest
opened 2026-05-28, covering every arc from a hypothesis someone had on a Tuesday
to a mechanism running in a released engine. It is fully git-tracked and
therefore public — an external reader can follow the whole arc.

That is the point, and it is also the hazard. These documents do not all carry
the same weight of evidence. Some describe behaviour a test suite gates on every
commit. Some describe behaviour seen once, in one live mind, on one afternoon.
Some describe a plan nobody has written a line of code for. Read in one voice,
they are indistinguishable — and the reader who cannot tell them apart will cite
the weakest one as if it were the strongest.

So every document carries a **Standing** line, directly under its title:

```markdown
> **Standing:** SHIPPED · 2026-08-31 · released in v0.10.0 · 52 of 57 items landed
```

The shape is fixed — `LEVEL · YYYY-MM-DD · what backs it` — so `INDEX.md` can be
generated from it and cannot drift from what the documents say.

## The four levels

### SHIPPED

In the engine, on `main`, gated by CI — determinism, replay equivalence,
snapshot/restore — and carried by a release.

*Cite it as:* something the engine does.
*The date is:* when it landed.

### OBSERVED

True of the real system at a moment, established by **looking** — a live run, a
trace through running code, an audit. Not gated by anything. It may already be
false.

*Cite it as:* a sighting, with its date and its n.
*The date is:* when it was seen.

An observation is not a lesser claim; it is a different one. Half the faults this
engine has fixed were found this way and could not have been found any other way
— no test knew to ask. But an observation of one mind on one afternoon is n=1,
and the line must say so.

### DESIGNED

The reasoning is complete and the plan is of record. No code, or not enough code
to gate on.

*Cite it as:* intent. Never as capability.
*The date is:* when the design settled.

### SPECULATIVE

A sketch or a hypothesis. Unmeasured, possibly wrong, possibly abandoned
tomorrow. Kept because the reasoning is worth keeping.

*Cite it as:* a question the project is holding.
*The date is:* when it was written down.

## Qualifiers

Anything true of *part* of a document goes in the prose tail, after the date:

- `partial` — some phases landed, others open. The prose says which.
- `superseded by [[DOC]]` — the work moved. Open checkboxes here are history,
  not backlog.
- `parked` — deliberately not being worked, kept so it survives context loss.
- `n=1` — seen once, not replicated.

## Two hazards this folder actually has

**Dates before 2026-07-02 are older than the repository.** `will` was split into
its own public repo on 2026-07-02 and the history was squashed, so `git log`
reports that date for twenty-three documents that were written weeks earlier. The
documents themselves carry the true dates — 2026-05-28 is day zero — and the
Standing line uses those. Where a pre-public document records no date, its
Standing line reads `2026-07-02` and says so in the tail. **Do not date this
folder from git.**

**PR numbers in pre-public documents point at a different repository.** The
private repo's numbering ran ahead of the public one, and the two have now
collided: `KNOWN_ENTITY.md` cites `will#174` for entity resolution, while
`will#174` in this repository is a fix to SVG label placement. `will#168`,
`#170`, `#171` in `TRAIT_SALIENCE_GRADED.md` are, in public numbering, three
unrelated PRs from the SIGNAL_BOUNDARY epoch. A reader following those links
lands on the wrong commit and gets a false trail that looks entirely coherent.
Affected documents say so in their Standing line. Public numbering starts at
**#72**; anything below that, and anything a `git log` search cannot find, is
private-repo numbering.

## Why this exists

`EXAFFERENCE.md` sat marked OPEN for a month after every one of its twenty-three
items had shipped, and a later epoch went looking for work that was already done.
Its own header now records the lesson: *a stale status header on a shipped epoch
is worse than none.*

The engine's claim is that a mind's growth should be legible and replayable. The
record of building it should hold the same bar — which means saying, on every
document, how much weight it can bear.
