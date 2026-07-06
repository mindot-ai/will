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

- **Entity binding.** ✅ DONE (2026-07-05). An effector may declare `binds: 'entity'`
  (EffectorDeclaration / facade EffectorSpec); `externalSchemas()` sets it, and the
  AffordanceSynthesizer's entity pass was generalised from a single `find` to
  `filter( s => s.binds === 'entity' )` — every entity-bound schema (innate
  `reach-out` PLUS host effectors) is now bound against each perceived *sentient*
  known-entity, so the Will can `give`/`greet`/… someone in particular. The bound
  target reaches the host as `ctx.targetEntityId`; ids stay unique per
  (schema × entity). Tests: agency.external-abilities + sdk.facade.
  Object binding ✅ DONE (2026-07-06): `binds: 'object'` targets non-sentient
  `'thing'` known-entities (already produced by perception). The synthesizer's
  target-binding pass matches schema binding to entity kind (person→sentient,
  object→thing), never crossing. `SchemaBinding` gained `'object'`.
- **Per-effector metadata.** ✅ DONE (2026-07-05). `EffectorDeclaration` (types.ts)
  = a bare name OR `{ name, description?, cost?, valence?, preconditions? }`.
  `externalSchemas()` populates cost/baseValence/preconditions/description onto
  the MotorSchema; they flow through the existing affordance build + selection
  (an ability now gates on body state, carries a reward prior, competes on real
  effort). `description` (the ability's meaning) rides schema → invocation →
  host handler `ctx.description`, and travels in the PMA. Surfaced on the facade
  as `create({ effectors: { name: { handler, description?, cost?, valence?,
  preconditions? } } })`. Tests: agency.external-abilities + sdk.facade.
  Deliberation-surfacing ✅ DONE (2026-07-05): the afforded external abilities +
  their meaning + bound target are read from the field into
  `ExecutiveContext.abilities` (context.ts `extractAbilities`) and rendered as
  "## Abilities Available Now" in the executive prompt — framed as self-knowledge
  (what you can do), NOT a tool-call menu. `description` now also rides onto the
  affordance entity. AND the DeliberationEngine's candidate list (the specific
  options System 2 chooses between when a competition is contested) now renders
  each candidate's meaning too — `ActionSelector` carries `description` onto the
  deliberating candidates and `_buildFocusContent` shows `give toward ada —
  <meaning>` instead of a bare label. Tests: executive.abilities-awareness,
  agency.deliberation. Routing `tags` ✅ DONE (2026-07-06): a declaration may carry
  tags (merged with 'external'/'host', deduped) so a drive-recognised tag lifts the
  ability via selection.scoring's driveUrgency.
- **Field width.** N custom effectors all enter the floor uncapped. If hosts
  declare large catalogs, gate external affordances by attention/preconditions
  rather than emitting all of them every tick.
- **Learning surface.** External schemas already accrue `LearnedSkill` stats via
  reafference and travel in the PMA — verify host-acked outcomes feed
  `recordOutcome` with a meaningful `outcomeQuality` (the host's ack result), so
  the Will actually gets better at the host's effectors over time.
- **Runtime grant changes.** ✅ Partially DONE (2026-07-06). GRANTING a custom
  effector at runtime now adds its external schema to the live repertoire:
  `SchemaRepertoire.registerExternal(schema)` (adds a template without marking it
  learned) ← `WillStem.registerEffector(id, decl)` ← facade `.effector(name, entry)`
  (accepts a bare handler or a full spec; adds the schema so it can actually be
  afforded, not just granted). Tests: sdk.facade. Note: a runtime mutation — the
  deterministic/replayable path is declaring effectors at create time. Still open:
  REVOKING (removing a schema from the live repertoire) + wiring the backend
  `PATCH /v1/wills/:id/effectors` route to registerEffector.
