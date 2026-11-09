// ─────────────────────────────────────────────────────────────
// src/agency/schemas/external.ts  —  host-owned domain effectors
// ─────────────────────────────────────────────────────────────
//
// A host (game engine, app, robot) declares the domain effectors its world
// supports — `move`, `attack`, `trade`, `give`, `use`, … — via a profile's
// `effectors` list or the Will's `allowedGenericEffectors`. This turns those
// declarations into enactable MotorSchemas so they enter the agency loop like
// anything else: the AffordanceSynthesizer surfaces them in the field, the
// ActionSelector competes them, and the MotorSchemaExecutor routes the chosen
// one to the host via the `external` enaction mode (emitted now, acked later,
// the result returning as reafference the Will learns from).
//
// Excluded: the communication surface (listen/talk/text/gesture/broadcast),
// which is governed by AccessGrants + the ProactiveCommunicator; and any name
// that shadows an innate stance (the innate floor already provides it).
//
// Binding: a declaration chooses. `binds: 'none'` (the default) is objectless —
// the Will chooses the act and the host resolves the target. `binds: 'entity'`
// binds the schema against each perceived SENTIENT known-entity, `'object'`
// against each non-sentient one, and the bound target reaches the host as
// `ctx.targetEntityId`; the synthesizer matches schema binding to entity kind
// and never crosses them.
//
// What is still open is FIELD WIDTH, not binding: objectless schemas land on the
// always-offered floor, so a host declaring a large catalog emits every one of
// them every tick — and an ability that cannot run with empty arguments is
// offered anyway, chosen without them, and learned as a failure. See
// .TODO/CUSTOM_ABILITY_WIRING.md (Phase 2+, "Field width").
// ─────────────────────────────────────────────────────────────

import type { MotorSchema, EffectorDeclaration } from '#agency/types'
import { EXPLICIT_EFFECTORS } from '#agency/access.grants'
import { INNATE_SCHEMA_BY_ID } from '#agency/schemas/innate'

/** Default effort/energy demand for a host action when none is specified. */
const DEFAULT_EXTERNAL_COST = 0.15

const clamp = ( n: number, lo: number, hi: number ): number => n < lo ? lo : n > hi ? hi : n

/**
 * Build enactable MotorSchemas for a host's declared domain effectors. Comms
 * names and innate-shadowing names are filtered out; the rest become objectless,
 * `external`-tagged primitives that route to the host on enaction.
 *
 * A declaration may be a bare name (uniform prior) or an object carrying the
 * ability's meaning + intrinsic priors (`description`, `cost`, `valence`,
 * `preconditions`) — these seed the affordance so the ability competes with a
 * real effort/reward/gating profile instead of a flat default. Reafference
 * refines them from there.
 */
export function externalSchemas( effectors?: EffectorDeclaration[] | null ): MotorSchema[] {
  const seen = new Set<string>()
  const out:  MotorSchema[] = []

  for( const decl of effectors ?? [] ){
    const name = typeof decl === 'string' ? decl : decl?.name
    if( typeof name !== 'string' || name.length === 0 ) continue
    if( EXPLICIT_EFFECTORS.has( name ) )  continue   // communication — handled by AccessGrants
    if( INNATE_SCHEMA_BY_ID.has( name ) ) continue   // shadows an innate stance
    if( seen.has( name ) )                continue
    seen.add( name )

    const meta = typeof decl === 'string' ? null : decl
    const binds = meta?.binds === 'entity' ? 'entity' : meta?.binds === 'object' ? 'object' : 'none'
    // Declared routing tags merged with the mandatory 'external'/'host' markers
    // (the executor routes on 'external'; dedup keeps the set clean).
    const tags = [ ...new Set( [ ...( meta?.tags ?? [] ), 'external', 'host' ] ) ]

    out.push({
      id:            name,
      kind:          'primitive',
      source:        'external',
      cost:          typeof meta?.cost === 'number' ? clamp( meta.cost, 0, 1 ) : DEFAULT_EXTERNAL_COST,
      binds,
      baseValence:   typeof meta?.valence === 'number' ? clamp( meta.valence, -1, 1 ) : 0,
      ...( meta?.preconditions ? { preconditions: meta.preconditions } : {} ),
      ...( meta?.description   ? { description:   meta.description   } : {} ),
      tags,
    })
  }

  return out
}
