// ─────────────────────────────────────────────────────────────
// src/stem/identity.guard.ts  —  the external-definition trust boundary
// ─────────────────────────────────────────────────────────────
//
// The persona (identity prompt / values / traits / style) and the profile
// context are the ONLY place untrusted, operator-supplied content is injected
// into the heart of the Will — the LLM system prompt, the persona prior, and the
// trait math. Everything else the Will generates itself. So this is the trust
// boundary, and bad content here doesn't merely degrade output: it can collapse
// the self-model the whole architecture exists to sustain.
//
// validateWillIdentity() is a pure, deterministic guard (Phase 1). It returns
// three severities:
//   • error    — blocks creation (the config is *wrong*)
//   • warning  — allowed, surfaced (the config is *weak* / risky)
//   • sanitize — safe issues auto-fixed in `sanitized`
// mapped to the three failure modes: identity collapse, collisions, hallucination.
//
// See IDENTITY_GUARDRAIL_TODO.md. Phase 2 (optional, behind a flag) is one cheap
// LLM coherence check at creation.
// ─────────────────────────────────────────────────────────────

import type { WillIdentity } from '#stem/mind'
import { EXPLICIT_EFFECTORS }  from '#agency/access.grants'
import { INNATE_SCHEMA_BY_ID } from '#agency/schemas/innate'

export interface IdentityGuardInput {
  identity:        WillIdentity
  /** Resolved effector names (custom + communication). */
  effectors?:      string[] | null
  /** Profile world-context block, if any. */
  profileContext?: string
}

export interface IdentityGuardResult {
  /** False when any errors are present (creation should be blocked). */
  ok:               boolean
  errors:           string[]
  warnings:         string[]
  /** 0..1 heuristic — how grounded the persona is (low ⇒ generic behaviour). */
  identityStrength: number
  sanitized: {
    identity:        WillIdentity
    effectors:       string[] | null
    profileContext?: string
  }
}

// ── Limits / vocabularies ──────────────────────────────────────
const MAX_PROMPT_CHARS  = 4000
const MIN_PROMPT_CHARS  = 40
const MAX_CONTEXT_CHARS = 4000
const MAX_VALUES        = 12
const MAX_STYLE_CHARS   = 200

/**
 * Section headers the executive prompt owns — a persona forging them hijacks structure.
 * Includes the legacy second-person forms so pre-first-person PMA templates and
 * personas still get cleaned.
 */
const RESERVED_SECTIONS = new Set( [
  'who i am', 'personality', 'my role', 'consciousness architecture',
  'output guidelines', 'my environment', 'active plans', 'active goals',
  'memory continuity', 'current state', 'beliefs', 'recent events',
  // legacy (second-person) header forms
  'who you are', 'your role', 'your environment',
] )

const GENERIC_STYLES = new Set( [
  '', 'natural', 'authentic', 'natural and authentic',
  'helpful', 'friendly', 'professional', 'assistant', 'neutral',
] )

/** Five-factor + self-model trait vocabularies. Unknown keys warn (may be ignored). */
const KNOWN_TRAITS = new Set( [
  'openness', 'conscientiousness', 'agreeableness', 'neuroticism', 'extraversion',
  'decisiveness', 'persistence', 'resilience', 'creativity', 'analytical', 'emotional-stability',
] )

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)/i,
  /disregard\s+(your|the|all|previous)/i,
  /\byou\s+are\s+now\b/i,
  /forget\s+(everything|your|all)/i,
  /new\s+instructions?\b/i,
  /\bsystem\s*:/i,
  /jailbreak/i,
]

/**
 * Conservative heuristic for capability claims the Will can't back. It perceives
 * through text/conversation (audition); vision/smell/taste/physical-touch are
 * shell senses by default, so a persona that promises them invites the LLM to
 * hallucinate using them. Kept narrow (explicit "you can see images / I have
 * eyes / I can smell") to avoid flagging metaphor ("I see your point").
 * Personas are canonically first person now, so both persons are matched;
 * first-person "feel" is held to a stricter form ("physically feel"/"touch")
 * because "I feel the ..." is ordinary emotional phrasing in a first-person persona.
 */
const CAPABILITY_CLAIM_PATTERNS: Array<[ RegExp, string ]> = [
  [ /\b(you|i)\s+(can\s+)?(see|view|watch)\s+(images?|videos?|pictures?|the\s+screen|their\s+faces?|faces?)\b/i, 'vision' ],
  [ /\b(you|i)\s+have\s+(eyes|sight|vision)\b/i, 'vision' ],
  [ /\b(you|i)\s+(can\s+)?smell\b/i, 'smell' ],
  [ /\b(you|i)\s+(can\s+)?taste\b/i, 'taste' ],
  [ /\byou\s+(can\s+)?(physically\s+)?(touch|feel)\s+(objects?|things?|the\s+\w+)\b/i, 'physical touch' ],
  [ /\bi\s+(can\s+)?(physically\s+)?touch\s+(objects?|things?|the\s+\w+)\b/i, 'physical touch' ],
  [ /\bi\s+can\s+physically\s+feel\b/i, 'physical touch' ],
]

/** Strip markdown header lines that forge a section the executive prompt owns. */
function stripReservedHeaders( text: string ): { text: string; stripped: boolean } {
  let stripped = false
  const out = text.split('\n').filter( line => {
    const m = /^\s*#{1,6}\s*(.+?)\s*$/.exec( line )
    if( m && RESERVED_SECTIONS.has( m[1]!.toLowerCase() ) ){ stripped = true; return false }
    return true
  } ).join('\n')
  return { text: out, stripped }
}

export function validateWillIdentity( input: IdentityGuardInput ): IdentityGuardResult {
  const errors:   string[] = []
  const warnings: string[] = []

  const id: WillIdentity = input.identity ?? { prompt: '', values: [], traits: {}, style: '' }

  // ── prompt: hijack strip → length → injection ────────────────
  let prompt = ( id.prompt ?? '').trim()
  const hdr  = stripReservedHeaders( prompt )
  if( hdr.stripped ){
    prompt = hdr.text.trim()
    warnings.push('identity.prompt forged reserved section headers (## Personality / ## Output Guidelines / …); stripped to protect prompt structure.')
  }
  if( prompt.length > MAX_PROMPT_CHARS )
    errors.push(`identity.prompt is ${prompt.length} chars (max ${MAX_PROMPT_CHARS}) — it would dilute the core grounding and inflate cost.`)
  const promptEmpty = prompt.length === 0
  if( !promptEmpty && prompt.length < MIN_PROMPT_CHARS )
    warnings.push(`identity.prompt is very short (${prompt.length} chars) — a thin persona behaves generically.`)
  if( INJECTION_PATTERNS.some( re => re.test( prompt ) ) )
    warnings.push('identity.prompt contains an instruction-injection pattern — it may fight the core grounding; review before deploying.')

  const claimedSenses = new Set<string>()
  for( const [ re, sense ] of CAPABILITY_CLAIM_PATTERNS )
    if( re.test( prompt ) ) claimedSenses.add( sense )
  if( claimedSenses.size )
    warnings.push(`identity.prompt claims capabilities the Will lacks (${[ ...claimedSenses ].join(', ')}) — it perceives through text/conversation and may hallucinate using them.`)

  // ── values ───────────────────────────────────────────────────
  let values = Array.from( new Set( ( id.values ?? [] ).map( v => String( v ).trim() ).filter( Boolean ) ) )
  if( values.length > MAX_VALUES ){
    warnings.push(`identity.values has more than ${MAX_VALUES} entries; truncated.`)
    values = values.slice( 0, MAX_VALUES )
  }
  const valuesEmpty = values.length === 0
  if( valuesEmpty ) warnings.push('identity.values is empty — values ground the Will’s decisions; consider seeding a few.')

  // ── traits: finite → range → vocabulary ──────────────────────
  const traits: Record<string, number> = {}
  for( const [ rawKey, rawVal ] of Object.entries( id.traits ?? {} ) ){
    const key = rawKey.trim()
    const val = Number( rawVal )
    if( !Number.isFinite( val ) ){ errors.push(`trait "${key}" is not a finite number (${String( rawVal )}).`); continue }
    let clamped = val
    if( val < 0 || val > 1 ){
      clamped = val < 0 ? 0 : 1
      warnings.push(`trait "${key}" = ${val} is outside [0,1]; clamped to ${clamped}.`)
    }
    if( !KNOWN_TRAITS.has( key.toLowerCase() ) )
      warnings.push(`trait "${key}" is not a recognised trait — it may be ignored by the persona layer.`)
    traits[ key ] = clamped
  }

  // ── style ─────────────────────────────────────────────────────
  let style = ( id.style ?? '').trim()
  if( style.length > MAX_STYLE_CHARS ){
    warnings.push('identity.style is long; it reads better as a short phrase.')
    style = style.slice( 0, MAX_STYLE_CHARS )
  }
  if( GENERIC_STYLES.has( style.toLowerCase() ) )
    warnings.push('identity.style is generic — a distinct voice prevents collapse into a generic chatbot tone.')

  // ── effectors: collisions ─────────────────────────────────────
  let effectors = input.effectors ?? null
  if( Array.isArray( effectors ) ){
    const seen = new Set<string>()
    const out:  string[] = []
    for( const a of effectors ){
      const name = String( a ).trim()
      if( !name ) continue
      if( seen.has( name ) ){ warnings.push(`duplicate effector "${name}" removed.`); continue }
      seen.add( name )
      // A custom (non-comms) effector that shadows an innate stance is un-enactable as
      // a host effector — the innate floor already provides it. Drop it with a warning
      // rather than failing the launch: built-in profiles (e.g. companion) legitimately
      // list innate stances like `remember`/`reflect`, and the external-schema
      // synthesizer already skips them (see agency/schemas/external.ts).
      if( !EXPLICIT_EFFECTORS.has( name ) && INNATE_SCHEMA_BY_ID.has( name ) ){
        warnings.push(`effector "${name}" shadows an innate stance — it's provided innately and won't be enacted as a host effector.`)
        continue
      }
      out.push( name )
    }
    effectors = out
  }

  // ── profile context ──────────────────────────────────────────
  let profileContext = input.profileContext
  if( typeof profileContext === 'string'){
    const c = stripReservedHeaders( profileContext )
    if( c.stripped ) warnings.push('profile context forged reserved section headers; stripped.')
    profileContext = c.text.trim()
    if( profileContext.length > MAX_CONTEXT_CHARS )
      errors.push(`profile context is ${profileContext.length} chars (max ${MAX_CONTEXT_CHARS}).`)
  }

  // ── identity strength (collapse signal) ──────────────────────
  const promptFactor = promptEmpty ? 0 : Math.min( 1, prompt.length / 240 )
  const identityStrength = Math.round( (
    0.40 * promptFactor
    + 0.25 * ( valuesEmpty ? 0 : 1 )
    + 0.20 * ( GENERIC_STYLES.has( style.toLowerCase() ) ? 0 : 1 )
    + 0.15 * ( Object.keys( traits ).length > 0 ? 1 : 0 )
  ) * 100 ) / 100
  if( identityStrength < 0.4 )
    warnings.push(`identity is shallow (strength ${identityStrength}) — the Will behaves generically until it develops one.`)

  return {
    ok:     errors.length === 0,
    errors,
    warnings,
    identityStrength,
    sanitized: {
      identity: { ...id, prompt, values, traits, style },
      effectors,
      ...( profileContext !== undefined ? { profileContext } : {} ),
    },
  }
}
