// ─────────────────────────────────────────────────────────────
// src/cognition/senses/audition.engine/salience.ts
// ─────────────────────────────────────────────────────────────
//
// Language salience — how much a given inbound message *matters*, before the
// per-entity novelty model (GenerativeModel.observe) modulates it.
//
// Pure + deterministic: a function of the message content, the speaker's
// attachment strength, and the Will's active-goal topics. No wall-clock — the
// score feeds attention allocation + GWT workspace gating, which are
// replay-sensitive, so it must not depend on non-deterministic time.
// "Recency/novelty" is handled separately by the per-entity GenerativeModel
// baseline (a normally-quiet entity suddenly speaking spikes), not here.
// ─────────────────────────────────────────────────────────────

export interface LanguageSalienceInput {
  /** Raw message text. */
  content:         string
  /** Speaker's attachment strength, 0–1 (0 = stranger / no bond). */
  attachmentScore: number
  /** Active-goal descriptions + tags, for topic-overlap detection. */
  activeGoalText:  string[]
}

const URGENCY = /urgent|critical|help|asap|emergency|now\b/i

const clamp01 = ( n: number ): number => Math.max( 0, Math.min( 1, n ) )

/** True when the message shares a meaningful token with any active goal. */
function overlapsActiveGoal( content: string, activeGoalText: string[] ): boolean {
  if( activeGoalText.length === 0 ) return false
  const lc = content.toLowerCase()
  for( const text of activeGoalText )
    for( const word of text.toLowerCase().split( /\W+/ ) )
      if( word.length > 3 && lc.includes( word ) ) return true
  return false
}

/**
 * Compute language salience (0–1) for an inbound message.
 *
 * Weighting (sums, then clamps):
 *   - base       0.15  — a floor so a first/neutral message is non-trivial
 *   - urgency    0.30  — explicit urgency keywords
 *   - attachment 0.35  — closer relationship ⇒ more salient (the big lever)
 *   - goal       0.15  — topic overlaps an active goal
 *   - length     0.05  — longer ⇒ slightly more substantive (normalised to 200 chars)
 */
export function computeLanguageSalience( opts: LanguageSalienceInput ): number {
  const { content, attachmentScore, activeGoalText } = opts

  const base    = 0.15
  const urgency = URGENCY.test( content )                       ? 0.30 : 0
  const attach  = clamp01( attachmentScore ) * 0.35
  const goal    = overlapsActiveGoal( content, activeGoalText ) ? 0.15 : 0
  const length  = Math.min( 1, content.length / 200 )           * 0.05

  return clamp01( base + urgency + attach + goal + length )
}
