// ─────────────────────────────────────────────────────────────
// src/agency/competence.codec.ts  —  portable competence
// ─────────────────────────────────────────────────────────────
//
// The original PMA carried who a Will *is*, *believes*, and *cares about* — but
// not what it had *learned to do*. A person who keeps their opinions and bonds
// but forgets every skill each morning is not continuity. This codec closes that
// gap: it distills the competence layer (learned composite schemas + their
// LearnedSkill stats) into a portable fragment, and reloads it so a re-embodied
// Will *acts like itself* — its habits, its proceduralized skills, its learned
// parameter defaults — not just feels and believes like itself.
//
// Soul doctrine (mirrors the existing PMA relationship distiller): what
// crystallizes across a restart is what *mattered*. Fleeting, barely-practiced
// skills fall below the carry floor and fade — the forgetting curve, made
// portable. Strong habits carry.
// ─────────────────────────────────────────────────────────────

import type { MotorSchema, LearnedSkill } from '#agency/types'
import type { SchemaRepertoire } from '#agency/schemas/repertoire'

export const COMPETENCE_SCHEMA_VERSION = 1

export interface CompetenceSnapshot {
  schemaVersion: number
  /** Learned composite schema DEFINITIONS (the innate floor is intrinsic — not carried). */
  composites: MotorSchema[]
  /** Per-schema learned skills above the carry floor, ranked by consolidation. */
  skills: LearnedSkill[]
}

export interface DistillOptions {
  /** Skills below this habit strength are not carried (the forgetting floor). */
  minHabit?: number
  /** Cap on carried skills, ranked by consolidation. */
  maxSkills?: number
}

const DEFAULT_MIN_HABIT = 0.2
const DEFAULT_MAX_SKILLS = 50

/** Consolidation score — how much a skill has "set" — used for ranking the carry. */
function consolidation( s: LearnedSkill ): number {
  return s.habitStrength * 0.6
    + s.valueEstimate * 0.2
    + Math.min( 1, s.enactments * 0.02 ) * 0.2
}

/**
 * Distill the repertoire's competence into a portable snapshot. Carries the
 * strongest skills (above the floor) and only the learned composite templates
 * that still have a carried skill — so no orphan templates ride along.
 */
export function distillCompetence(
  repertoire: SchemaRepertoire,
  opts: DistillOptions = {},
): CompetenceSnapshot {
  const minHabit  = opts.minHabit  ?? DEFAULT_MIN_HABIT
  const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS

  const { composites, skills } = repertoire.export( minHabit )

  const carriedSkills = [ ...skills ]
    .sort( ( a, b ) => consolidation( b ) - consolidation( a ) )
    .slice( 0, maxSkills )

  const carriedIds = new Set( carriedSkills.map( s => s.schema ) )
  const carriedComposites = composites.filter( c => carriedIds.has( c.id ) )

  return {
    schemaVersion: COMPETENCE_SCHEMA_VERSION,
    composites:    carriedComposites,
    skills:        carriedSkills,
  }
}

/**
 * Reload a competence snapshot into a (typically fresh) repertoire, so the Will
 * resumes with its learned skills and composites intact. Composites are
 * registered first (re-creating their templates), then skills overwrite the
 * fresh stubs with the carried, consolidated values.
 */
export function loadCompetence(
  snapshot: CompetenceSnapshot | null | undefined,
  repertoire: SchemaRepertoire,
): void {
  if( !snapshot || snapshot.schemaVersion !== COMPETENCE_SCHEMA_VERSION ) return
  repertoire.import({ composites: snapshot.composites, skills: snapshot.skills })
}
