# Will — Custom (host-owned) effector wiring

> **Status: 🟢 Phase 1 wired.** A host's declared domain effectors now reach the
> agency field and route to the world. Phases 2+ (entity binding, per-effector
> metadata, preconditions, learning surface) are follow-ups.

## The gap (found 2026-06-15)

A profile (or `allowedGenericEffectors`) declares the effectors a host's world
supports — e.g. `game-npc` lists `move`, `attack`, `trade`, `give`, `take`,
`use`, `observe`, `remember`. But the agency pipeline never turned those into
anything the Will could choose:

- `SchemaRepertoire` and `AffordanceSynthesizer` were seeded **innate-only**
  (`mind.ts`), so the affordance field only contained the innate floor + percept
  + social + learned composites.
- `profile.effectors` only seeded `AccessGrants`, which **only filters the five
  communication names** (`listen`/`talk`/`text`/`gesture`/`broadcast`) — every
  other name is "freely allowed" but had **no `MotorSchema`**, so it could never
  be afforded, selected, or enacted.

Net effect: a `game-npc` Will could `talk`/`express`/`rest`/`reach-out`, but
could never `move` or `attack`, despite the profile listing them and the README
implying custom effectors dispatch via `effector_invoked`.

## Phase 1 — wired (this change)

- `src/engines/agency/schemas/external.ts` — `externalSchemas(effectors)` turns
  declared domain effectors into enactable `MotorSchema`s: objectless
  (`binds: 'none'`), `source: 'external'`, tagged `external`. Comms names and
  names shadowing an innate stance are filtered out.
- `mind.ts` seeds the repertoire with `[...INNATE_SCHEMAS, ...externalSchemas(resolvedEffectors)]`.
- The `AffordanceSynthesizer` already surfaces every `binds: 'none'` schema as an
  always-available floor affordance; the `MotorSchemaExecutor` already routes a
  schema tagged `external` to the host via the `external` enaction mode (emitted
  now, acked later by `confirmEffectorExecution`, returning as reafference). So no
  change was needed downstream — only the missing seam at the head of the loop.
- `AffordanceSource` gains `'external'` (provenance). Test:
  `tests/unit/agency.external-effectors.test.ts`.

The Will can now choose a host effector, the host executes it, and the outcome
feeds the agency learning loop like any other action.

## Phase 2+ — follow-ups

- **Entity binding.** External effectors are objectless today (the host resolves
  the target). The synthesizer binds a *single* entity schema (`reach-out`); to
  let `attack`/`give`/`trade` target a *specific* perceived entity, generalise
  the entity-binding pass to bind N entity-binding schemas, and let an effector
  declare `binds: 'entity'`.
- **Per-effector metadata.** Effectors are flat strings → uniform cost (0.15),
  no preconditions, no affective prior. Let a profile declare an effector as an
  object (`{ name, cost?, binds?, preconditions?, baseValence?, tags? }`) so e.g.
  `attack` can gate on energy and carry a risk/threat prior.
- **Field width.** N custom effectors all enter the floor uncapped. If hosts
  declare large catalogs, gate external affordances by attention/preconditions
  rather than emitting all of them every tick.
- **Learning surface.** External schemas already accrue `LearnedSkill` stats via
  reafference and travel in the PMA — verify host-acked outcomes feed
  `recordOutcome` with a meaningful `outcomeQuality` (the host's ack result), so
  the Will actually gets better at the host's effectors over time.
- **Runtime grant changes.** `PATCH /v1/wills/:id/effectors` updates `AccessGrants`
  (comms). Decide whether granting/revoking a *custom* effector at runtime should
  add/remove its external schema from the live repertoire too.
