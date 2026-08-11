// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/parser.ts
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import { REPLY_TEXT_TAG, NO_MESSAGE_TAG, NO_MESSAGE_OPEN } from '#llm/wire.contracts'
import type { ReadonlySimulationState } from '#core/types'
import type { ExecutiveOutputFull, ExecutiveOutputMinimal, IdeationCandidate, IdeationOutput } from '#faculties/executive.engine/types'

/**
 * Parse the LLM's text response into an ExecutiveOutputFull.
 * Handles three paths:
 *   1. Direct JSON parse (when LLM outputs valid JSON)
 *   2. Balanced-bracket extraction (when JSON has unescaped content in strings)
 *   3. Heuristic fallback (when parsing fails entirely)
 */
export function parseResponse(
  responseText: string,
  state: ReadonlySimulationState,
  recentActionTypes: string[]
): ExecutiveOutputFull {
  // Find the first code block that contains "actions" (skips tool-query preamble)
  const
  codeBlocks = [ ...responseText.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g) ],
  actionsBlock = codeBlocks.find( m => m[1]!.includes('"actions"') ),
  fullText = actionsBlock?.[1]?.trim() ?? responseText.trim()

  let
  actions: Array<{ type: string; reasoning: string; expectedOutcome: string }>,
  confidence = 0.5

  // Strategy 1: direct JSON.parse
  try {
    const parsed = JSON.parse( fullText ) as {
      actions: typeof actions
      reasoning?: string
      confidence?: number
    }
    if( !Array.isArray( parsed.actions ) )
      throw new Error('actions is not an array')

    actions = parsed.actions
    confidence = parsed.confidence ?? 0.5
  }
  catch {
    // Strategy 2: balanced-bracket extractor
    const actionsStr = extractBalancedArray( fullText, 'actions')
    if( !actionsStr) {
      logger.warn('[executive] No actions found in response — using fallback')
      return buildFallbackOutput( state, recentActionTypes )
    }

    try { actions = JSON.parse( actionsStr ) }
    catch {
      logger.warn('[executive] Failed to parse actions array — using fallback')
      return buildFallbackOutput( state, recentActionTypes )
    }

    const confidenceMatch = fullText.match(/"confidence"\s*:\s*([\d.]+)/)
    confidence = confidenceMatch ? parseFloat( confidenceMatch[1]! ) : 0.5
  }

  // Parse tagged blocks from the extracted JSON text
  const full = parseTaggedBlocks({ actions, reasoning: fullText, confidence }, state )

  // [REPLY_TEXT] is a plain-text block that lives OUTSIDE the JSON code block.
  // Search the full response text so we find it even when the LLM used a code fence.
  const replyText = extractTextBlock( responseText, REPLY_TEXT_TAG )
  if( replyText ) full.replyText = replyText

  // A declared decision not to speak. Its own field rather than an empty
  // replyText, because "I chose silence" and "the facet produced nothing" are
  // different events: one is a decision worth recording, the other a failure worth
  // noticing, and collapsing them hides both.
  // Presence of the MARKER is the decision — not the content, which may legitimately
  // be empty. `extractTextBlock` returns null for an absent tag AND for a present
  // but empty one, so it cannot tell them apart; testing it for undefined (as this
  // first did) is true in every case and made the mind mute on every path. The
  // integration suite caught it; a live boot would have caught it as total silence.
  if( responseText.includes( NO_MESSAGE_OPEN ) )
    full.noMessage = extractTextBlock( responseText, NO_MESSAGE_TAG ) ?? '(no reason given)'

  return full
}

/**
 * Parse the ideation (propose) pass into an IdeationOutput. Mirrors parseResponse's
 * resilience: prefer a fenced ```json block, fall back to raw text, then to
 * balanced-bracket extraction of the `candidates` array. Returns an EMPTY candidate set
 * on total failure — the caller then proceeds as if no options were generated (the
 * decision pass simply runs without an injected set), so a flaky propose pass degrades
 * gracefully rather than breaking the tick. Pure: no state, no I/O.
 */
export function parseIdeation( responseText: string ): IdeationOutput {
  const
  codeBlocks = [ ...responseText.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g) ],
  block = codeBlocks.find( m => m[1]!.includes('"candidates"') ),
  text  = block?.[1]?.trim() ?? responseText.trim()

  const coerce = ( raw: unknown ): IdeationCandidate[] => {
    if( !Array.isArray( raw ) ) return []
    return raw
      .map( c => {
        const o = ( c ?? {} ) as Record<string, unknown>
        return {
          approach:    String( o.approach    ?? '').trim(),
          description: String( o.description ?? '').trim(),
          upside:      String( o.upside      ?? '').trim(),
          risk:        String( o.risk        ?? '').trim(),
        }
      } )
      .filter( c => c.approach.length > 0 || c.description.length > 0 )
  }

  // Strategy 1: direct JSON parse of the (block-or-raw) text.
  try {
    const parsed = JSON.parse( text ) as { candidates?: unknown }
    const candidates = coerce( parsed.candidates )
    if( candidates.length > 0 ) return { candidates }
  }
  catch { /* fall through to bracket extraction */ }

  // Strategy 2: balanced-bracket extraction of the `candidates` array.
  const arrStr = extractBalancedArray( text, 'candidates')
  if( arrStr ){
    try { return { candidates: coerce( JSON.parse( arrStr ) ) } }
    catch { /* fall through to empty */ }
  }

  logger.warn('[executive] ideation parse failed — no candidates (deliberate pass proceeds without an injected set)')
  return { candidates: [] }
}

/**
 * Extract the JSON array value for `key` from `text` using balanced-bracket
 * counting. Properly skips characters inside JSON string literals.
 */
function extractBalancedArray( text: string, key: string ): string | null {
  const keyMatch = text.match( new RegExp(`"${key}"\\s*:\\s*(\\[)`) )
  if( !keyMatch || keyMatch.index === undefined ) return null

  const start = keyMatch.index + keyMatch[0].length - 1
  let
  depth = 0,
  inString = false,
  escape = false

  for( let i = start; i < text.length; i++ ){
    const ch = text[i]!
    if( escape ){
      escape = false
      continue
    }

    if( ch === '\\' && inString ){
      escape = true
      continue
    }

    if( ch === '"'){
      inString = !inString
      continue
    }

    if( inString ) continue

    if( ch === '[' || ch === '{') depth++
    else if( ch === ']' || ch === '}'){
      depth--

      if( depth === 0 ) 
        return text.slice( start, i + 1 )
    }
  }

  return null
}

/**
 * Parse tagged JSON blocks from the reasoning text.
 * The LLM embeds optional outputs as [TAG]...[/TAG] blocks.
 */
function parseTaggedBlocks(
  minimal: ExecutiveOutputMinimal,
  state: ReadonlySimulationState,
): ExecutiveOutputFull {
  const
  full: ExecutiveOutputFull = {
    actions: minimal.actions,
    reasoning: minimal.reasoning,
    confidence: minimal.confidence,
  },
  text = minimal.reasoning,

  // Diagnostic logging — REPLY_TEXT is detected in parseResponse() directly
  taggedTypes = [
    'PLANS',
    'BELIEFS',
    'INTROSPECTION',
    'NARRATIVE',
    'IDENTITY',
    'KNOWN_ENTITIES',
    'GOALS_NEW',
    'GOALS_ABANDON',
    'GOALS_REPRIORITIZE',
    'EFFECTORS',
    'SELF_OBS',
    'SKILLS',
  ],
  found = taggedTypes.filter( t => text.includes(`[${t}]`) )
  if( found.length > 0 ){
    const closed = found.map( t => `${t}: ${text.includes(`[/${t}]`) ? 'CLOSED' : 'UNCLOSED'}`).join(', ')
    logger.info(`[executive] TAGGED BLOCKS: ${closed}`)
  }

  const parseJsonBlock = ( tag: string ): unknown | null => {
    const block = extractBlock( text, tag )
    if( !block ) return null

    const trimmed = block.trim()

    // Parse-then-repair (FN10). The common case is already-valid, correctly
    // escaped JSON — try it verbatim first. The old code *unconditionally*
    // ran a destructive un-escape (\" → ", \\n → literal newline, \\ → \)
    // before parsing, which mangled valid JSON so JSON.parse threw and the
    // block was silently dropped. Whether it broke depended on whether the
    // content happened to contain escapable characters → non-deterministic,
    // content-dependent loss of PLANS/BELIEFS/GOALS/NARRATIVE/… blocks.
    try { return JSON.parse( trimmed ) }
    catch { /* not directly parseable — fall through to best-effort repair */ }

    // Repair pass only for the rarer case where the model double-escaped the
    // payload. Best-effort: if it still doesn't parse, drop the optional block.
    try {
      const repaired = trimmed.replace(/\\"/g, '"')
                              .replace(/\\n/g, '\n')
                              .replace(/\\\\/g, '\\')
      return JSON.parse( repaired )
    }
    catch { return null }
  }

  // Plans
  try {
    const plansData = parseJsonBlock('PLANS') as { plans?: ExecutiveOutputFull['plans'] } | null
    if( plansData?.plans ) full.plans = plansData.plans
  }
  catch { /* ignore parse errors for optional blocks */ }

  // Beliefs
  try {
    const beliefsData = parseJsonBlock('BELIEFS') as { newBeliefs?: ExecutiveOutputFull['newBeliefs'] } | null
    if( beliefsData?.newBeliefs ) full.newBeliefs = beliefsData.newBeliefs
  }
  catch { /* ignore */ }

  // Introspection
  try {
    const introspectionData = parseJsonBlock('INTROSPECTION') as { introspection?: ExecutiveOutputFull['introspection'] } | null
    if( introspectionData?.introspection ) full.introspection = introspectionData.introspection
  }
  catch { /* ignore */ }

  // Narrative
  try {
    const narrativeData = parseJsonBlock('NARRATIVE') as {
      narrative?: string; narrativeThemes?: string[]; currentSelfView?: string
    } | null
    if( narrativeData ){
      if( narrativeData.narrative ) full.narrative = narrativeData.narrative
      if( narrativeData.narrativeThemes ) full.narrativeThemes = narrativeData.narrativeThemes
      if( narrativeData.currentSelfView ) full.currentSelfView = narrativeData.currentSelfView
    }
  }
  catch { /* ignore */ }

  // Identity updates
  try {
    const identityData = parseJsonBlock('IDENTITY') as { identityUpdates?: ExecutiveOutputFull['identityUpdates'] } | null
    if( identityData?.identityUpdates ) full.identityUpdates = identityData.identityUpdates

    const knownEntityData = parseJsonBlock('KNOWN_ENTITIES') as { knownEntityUpdates?: ExecutiveOutputFull['knownEntityUpdates'] } | null
    if( knownEntityData?.knownEntityUpdates ) full.knownEntityUpdates = knownEntityData.knownEntityUpdates
  }
  catch { /* ignore */ }

  // New goals
  try {
    const goalsNewData = parseJsonBlock('GOALS_NEW') as { newGoals?: ExecutiveOutputFull['newGoals'] } | null
    if( goalsNewData?.newGoals ) full.newGoals = goalsNewData.newGoals
  }
  catch { /* ignore */ }

  // Goals to abandon
  try {
    const goalsAbandonData = parseJsonBlock('GOALS_ABANDON') as { goalsToAbandon?: ExecutiveOutputFull['goalsToAbandon'] } | null
    if( goalsAbandonData?.goalsToAbandon ) full.goalsToAbandon = goalsAbandonData.goalsToAbandon
  }
  catch { /* ignore */ }

  // Goals to reprioritize
  try {
    const goalsReprioritizeData = parseJsonBlock('GOALS_REPRIORITIZE') as { goalsToReprioritize?: ExecutiveOutputFull['goalsToReprioritize'] } | null
    if( goalsReprioritizeData?.goalsToReprioritize ) full.goalsToReprioritize = goalsReprioritizeData.goalsToReprioritize
  }
  catch { /* ignore */ }

  // Self-observations
  try {
    const selfObsData = parseJsonBlock('SELF_OBS') as { selfObservations?: string[] } | null
    if( selfObsData?.selfObservations ) full.selfObservations = selfObsData.selfObservations
  }
  catch { /* ignore */ }

  // Named compound skills — the creation seam for learned composites (#114).
  try {
    const skillsData = parseJsonBlock('SKILLS') as { newSkills?: ExecutiveOutputFull['newSkills'] } | null
    if( skillsData?.newSkills ) full.newSkills = skillsData.newSkills
  }
  catch { /* ignore */ }

  // [ACK] and legacy [REPLY] blocks are no longer emitted by any engine.
  // [ACK]   — removed with the legacy master communication path (Phase 13.8).
  // [REPLY] — replaced by [REPLY_TEXT] plain-text block in conversation facets.
  // Both are preserved as @deprecated fields on ExecutiveOutputFull for compatibility.

  return full
}

function extractBlock( text: string, tag: string ): string | null {
  const regex = new RegExp(`\\[${tag}\\]\\s*\\n?([\\s\\S]*?)\\n?\\[/${tag}\\]`, 'i')
  const match = text.match( regex )

  return match?.[1]?.trim() ?? null
}

/**
 * Extract plain text (not JSON) between [TAG] and [/TAG] markers.
 * Used for [REPLY_TEXT] — content is streamed directly to the client,
 * so it must be clean prose, not a JSON payload.
 */
function extractTextBlock( text: string, tag: string ): string | null {
  const open  = `[${tag}]`
  const close = `[/${tag}]`
  const openIdx  = text.indexOf( open )
  if( openIdx === -1 ) return null
  const contentStart = openIdx + open.length
  const closeIdx = text.indexOf( close, contentStart )
  const content  = closeIdx !== -1
    ? text.slice( contentStart, closeIdx )
    : text.slice( contentStart )   // unclosed block — take everything after the open marker

  return content.trim() || null
}

/**
 * What the executive intends when its own reasoning did not come back.
 *
 * Two things had to change here. Every action this produced was PROSE, not a
 * schema: `observe`, `replenish energy`, `enter deep rest to reduce fatigue`,
 * `calm my mind and reduce tension`, `explore`, `learn`, `express_emotion`.
 * Only `rest` names anything the body can enact. The rest reach the agency, fail
 * to resolve, and become an ideomotor push toward an act that does not exist —
 * observed live as `master decided [observe] conf=0.4` four times across two
 * boots, each one a decision that could go nowhere.
 *
 * And the "no urgent need" branch was INVENTION. The executive could not read
 * its own thought, so it made one up and pushed it into the field as intention.
 * That is the mind being told what it wants. The substrate does not need the
 * help: the affordance field is always there, System 1 selects from it every
 * tick without an executive, and it now carries real satiation — the monotony
 * this used to break by cycling a hardcoded list is handled where monotony
 * actually lives.
 *
 * So: reflexes stay, invention goes. Critically low energy, high sleep pressure
 * or high stress still push a real regulatory stance, because a body in trouble
 * should not depend on an LLM parsing correctly. Anything else yields NO action
 * and lets the substrate decide, which is what it is for.
 */
export function buildFallbackOutput(
  state: ReadonlySimulationState,
  _recentActionTypes: string[]
): ExecutiveOutputFull {
  const energy        = state.metrics.get('energy.level')  ?? 100
  const sleepPressure = state.metrics.get('sleep.pressure') ?? 0
  const stressLoad    = state.metrics.get('stress.load')    ?? 0

  // Innate stances only — what the body can actually enact.
  const reflex: { type: string; reasoning: string } | null =
      energy < 20        ? { type: 'rest',     reasoning: 'Energy critically low — I let myself recover.' }
    : sleepPressure > 60 ? { type: 'rest',     reasoning: 'Sleep pressure high — I let myself recover.' }
    : stressLoad > 70    ? { type: 'withdraw', reasoning: 'Stress elevated — I pull back from the press of things.' }
    : null

  return {
    actions: reflex
      ? [ { type: reflex.type, reasoning: reflex.reasoning, expectedOutcome: 'The body settles' } ]
      : [],
    reasoning: reflex
      ? `Heuristic fallback — my reasoning did not come back. ${ reflex.reasoning }`
      : 'Heuristic fallback — my reasoning did not come back, and nothing about my state is pressing. I intend nothing in particular; my body goes on choosing.',
    confidence: 0.4
  }
}