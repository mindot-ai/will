// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/deliberate.reasoning.ts
// ─────────────────────────────────────────────────────────────

/**
 * Shared System 2 machinery for the master AND its facets.
 *
 * Facets are "the master over their focus" — they reason with the same PromptFactory +
 * parser and make their own deliberate decision (e.g. a planning facet: replan / continue
 * / abandon). So they deliberate the same way: an a-priori effort gate (`selectProcess`)
 * picks fast vs deliberate, and on the deliberate path a *propose* pass generates a
 * divergent candidate set that the *decision* pass weighs before committing.
 *
 * This module owns the one genuinely shared, new piece — the propose (ideation) pass —
 * so master and facet share it rather than duplicating. Each caller keeps its own
 * prompt-building, decision call (with its own streaming/logging), and parsing.
 */

import type { LLMDirector, LLMCallMeta } from '#llm/index'
import type { IdeationCandidate } from '#faculties/executive.engine/types'
import { parseIdeation } from '#faculties/executive.engine/parser'

export interface ProposeParams {
  director: LLMDirector
  /** Same system prompt the decision pass uses — shares the prompt cache. */
  systemPrompt: string
  /** User message carrying the ideation output-format override (full context, asks for options). */
  ideationUserMessage: string
  tick: number
  /** Elevated sampling temperature (creativity-driven) — diverge when proposing. */
  proposeTemperature: number
  /**
   * Cost-attribution for the propose (ideation) pass. The caller passes its own
   * attribution (master vs facet, with its scope) so the System-2 overhead is
   * billed to the right bucket under `function: 'ideation'`. Defaults to the
   * master executive when unset.
   */
  meta?: LLMCallMeta
}

/**
 * Run the propose (ideation) pass: one non-streaming LLM call at elevated temperature,
 * returning the parsed candidate set. The call is internal scratch (nothing streams to a
 * user). A failure or empty parse degrades gracefully to `undefined`, so the caller then
 * proceeds exactly as System 1 (no candidates injected). R2-safe: the distinct ideation
 * prompt gets its own replay entry at this tick.
 */
export async function proposeCandidates( params: ProposeParams ): Promise<IdeationCandidate[] | undefined> {
  try {
    const result = await params.director.call(
      params.systemPrompt, params.ideationUserMessage, params.tick, params.proposeTemperature,
      params.meta ?? { category: 'executive', attribute: 'master', function: 'ideation' }
    )
    const candidates = parseIdeation( result.text ).candidates
    return candidates.length > 0 ? candidates : undefined
  }
  catch {
    return undefined  // degrade to System 1 — never let a flaky propose pass break a tick
  }
}
