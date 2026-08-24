// ─────────────────────────────────────────────────────────────
// tests/unit/sense.boundary.completeness.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The sense boundary must be COMPLETE, not merely enforced.
 *
 * `tests/integration/sense.boundary.test.ts` proves enforcement: a mind alone in
 * the dark perceives nothing. It cannot prove completeness, and the distinction
 * is not academic — it is why two real gaps survived it:
 *
 *   • its offender check is `MIND_OWN_ENTITY_TYPES.has( category )`, so a type
 *     MISSING from the set is invisible to it by construction;
 *   • a mind in the dark never enacts and is never refused, so the code paths
 *     that write `agency.enacted` and `agency.availability` never run there.
 *
 * Measured on a live Will before the fix: `New agency.enacted: agency-enacted-
 * discord_lookup_…` sat at salience 0.5 — the single loudest thing in her
 * perceptual field, above every real percept. And `agency.availability` is
 * empty until a refusal lands, so a Will with a refusing PolicyArbiter would
 * have started perceiving its own permissions changing as world events.
 *
 * This file closes the class rather than the two instances: every entity type
 * the mind writes ABOUT ITS OWN OPERATION is named here, and adding a new one
 * without declaring it fails.
 */

import { describe, it, expect } from 'vitest'
import { MIND_OWN_ENTITY_TYPES } from '#cognition/sense.boundary'
import { CONSEQUENCE_TYPE, ENACTED_TYPE } from '#agency/consequence'
import { REVOCATION_TYPE } from '#agency/revocation'
import { SETTLEMENT_TYPE } from '#agency/settlement'
import { SENT_TYPE, RECEIVED_TYPE } from '#agency/conversation.aim'
import { AVAILABILITY_ENTITY_TYPE, SCHEMA_ENTITY_TYPE } from '#agency/schemas/repertoire'
import { ACTION_RECORD_TYPE } from '#faculties/executive.engine/action.record'
import { AFFECT_STATE_TYPE } from '#faculties/affective.blender'

/**
 * Every exported entity-type constant naming something the mind writes about
 * itself. Imported rather than string-matched: a rename moves with the code,
 * and a NEW constant that belongs here is a deliberate addition by whoever adds
 * it — which is the point. If you are here because this list feels like a
 * chore, that is the cost of the boundary being a list; the alternative is a
 * mind that perceives its own bookkeeping and cannot tell you why it is busy.
 */
const MIND_OWN_TYPE_CONSTANTS: ReadonlyArray<readonly [ string, string ]> = [
  [ 'CONSEQUENCE_TYPE',          CONSEQUENCE_TYPE ],
  [ 'ENACTED_TYPE',              ENACTED_TYPE ],
  [ 'REVOCATION_TYPE',           REVOCATION_TYPE ],
  [ 'SETTLEMENT_TYPE',           SETTLEMENT_TYPE ],
  [ 'SENT_TYPE',                 SENT_TYPE ],
  [ 'RECEIVED_TYPE',             RECEIVED_TYPE ],
  [ 'AVAILABILITY_ENTITY_TYPE',  AVAILABILITY_ENTITY_TYPE ],
  [ 'SCHEMA_ENTITY_TYPE',        SCHEMA_ENTITY_TYPE ],
  [ 'ACTION_RECORD_TYPE',        ACTION_RECORD_TYPE ],
  [ 'AFFECT_STATE_TYPE',         AFFECT_STATE_TYPE ],
]

describe('the sense boundary is complete, not just enforced', () => {
  it.each( MIND_OWN_TYPE_CONSTANTS )(
    '%s (%s) is declared as the mind\'s own',
    ( _name, type ) => {
      expect( MIND_OWN_ENTITY_TYPES.has( type ) ).toBe( true )
    },
  )

  it('names every constant it knows about — a silent shrink is a regression', () => {
    // Guards the guard: deleting a row above would make this file quietly weaker
    // while still passing. The count is the tripwire.
    expect( MIND_OWN_TYPE_CONSTANTS ).toHaveLength( 10 )
  } )
} )
