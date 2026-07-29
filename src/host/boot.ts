// ─────────────────────────────────────────────────────────────
// src/host/boot.ts — shared boot/shutdown for the `will` CLI hosts
// ─────────────────────────────────────────────────────────────
//
// Both hosts (`will mcp`, `will serve`) raise the same mind the same way:
// env-configured, woken from its PMA artifact when one exists (else born),
// optionally bridged onto external MCP servers whose tools become its own
// abilities, and hibernated back to the artifact exactly once on the way out.
// Only the protocol surface differs — that stays in each host.
//
// Env (shared):
//   WILL_NAME        display name                    (default "Will")
//   WILL_IDENTITY    persona prompt                  (default a minimal self)
//   WILL_TIER        basic | standard | full         (default standard)
//   WILL_LLM         mock | any provider name        (default: auto — whichever
//                                                     provider's own key is set,
//                                                     else the zero-key mock)
//   WILL_LLM_MODEL   concrete model id               (REQUIRED for a live mind —
//                                                     the engine has no default)
//   WILL_TICK_MS     ms per tick                     (default 1000)
//   WILL_SEED        deterministic seed (testing)    (default unseeded/wall-time)
//   WILL_PMA_PATH    PMA artifact path               (default ./.will/<name>.pma.json)
//   WILL_MCP_SERVERS JSON array of MCP servers whose tools become the Will's
//                    OWN abilities: entries {command,args?,env?} or {url}.
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setLogger } from '#core/logger'
import { Will, detectProvider, type CreateWillOptions } from '#sdk/will'
import type { PMASnapshot } from '#pma/index'
import { connectMcpEffectors, type McpToolsSource } from '#root/mcp/effectors'
import { anthropicWireHeaders, defaultBaseFor, knownWireFor, providerKeyFromEnv, PROVIDER_KEY_ENV, type LLMProvider, type LLMWire } from '#llm/index'

/**
 * Route every engine log line to stderr. For `will mcp`, stdout is the MCP
 * protocol channel and must stay pure; `will serve` keeps the same discipline
 * so both hosts log identically (and Docker captures one stream).
 */
export function routeLogsToStderr(): void {
  const err = ( level: string ) => ( msg: string, ...rest: unknown[] ) =>
    console.error(`[will:${ level }] ${ msg }`, ...rest )
  setLogger( { debug: () => {}, info: err('info'), warn: err('warn'), error: err('error') } )
}

function slug( s: string ): string {
  return s.toLowerCase().replace( /[^a-z0-9]+/g, '-').replace( /^-+|-+$/g, '') || 'will'
}

/** The LLM mode the hosts will boot with: an explicit WILL_LLM, else whichever
 *  provider's key is present, else the zero-key mock. */
export function resolveLlmMode(): 'mock' | LLMProvider {
  const explicit = process.env.WILL_LLM
  if( explicit ) return explicit as 'mock' | LLMProvider
  // The SDK's own detection, not a copy of it. Boot used to know only
  // anthropic/glm, so once the provider set widened, a Will booting live on
  // (say) Kimi had its preflight silently skipped — the one check that exists
  // to stop a mind that boots, perceives, and never speaks.
  return detectProvider()
}

/** The key for a live mode — the provider-agnostic override first, then the
 *  provider's own env. */
function resolveLlmKey( mode: LLMProvider ): string | undefined {
  return process.env.WILL_LLM_API_KEY ?? providerKeyFromEnv( mode )
}

/**
 * The smallest real completion request, in a given wire's dialect.
 *
 * `null` means "this wire has no cheap ping here" — the caller raises the mind
 * unchecked rather than inventing a request shape and reading its rejection as
 * a broken provider.
 */
export function pingRequest(
  wire: LLMWire, base: string, model: string, key: string, provider: LLMProvider,
): { url: string; headers: Record<string, string>; body: unknown } | null {
  const messages = [ { role: 'user', content: 'ping' } ]
  switch( wire ){
    case 'anthropic':
      return {
        url:     `${ base }/messages`,
        headers: anthropicWireHeaders( provider, key ),
        body:    { model, max_tokens: 1, messages },
      }
    case 'openai':
      return {
        url:     `${ base }/chat/completions`,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ key }` },
        body:    { model, max_tokens: 1, messages },
      }
    // Gemini authenticates in the query string and nests its payload
    // differently enough that a hand-rolled ping here would drift from the
    // client that actually makes the calls. Better unchecked than wrong.
    case 'google': return null
  }
}

/**
 * Ask the executive's provider one trivial question BEFORE raising the mind.
 *
 * A Will whose LLM fails cannot reason, and an unreasoning Will is *silent* —
 * which is precisely what a Will that chose silence looks like. Mid-run that
 * ambiguity is the paradigm working. At boot it is indistinguishable from
 * broken, and costs an operator an afternoon of watching a mind that joined,
 * perceived, and never spoke. So we fail loudly here instead.
 *
 * Config errors (bad key, empty balance, unknown model) are fatal — the Will
 * would never speak. Transient ones (rate limit, provider 5xx) only warn: the
 * mind is worth raising, and the executive retries on its own cadence.
 *
 * Skipped for the mock executive and the no-LLM `reflex` anatomy.
 */
async function preflightLLM( anatomy: string ): Promise<void> {
  const mode = resolveLlmMode()
  if( mode === 'mock' || anatomy === 'reflex') return

  const key = resolveLlmKey( mode )
  if( !key ){
    const expected = PROVIDER_KEY_ENV[ mode ] ?? 'WILL_LLM_API_KEY'
    console.error(`[will] WILL_LLM=${ mode } but no ${ expected } / WILL_LLM_API_KEY is set.`)
    console.error('[will] The Will would boot, perceive, and never speak. Set a key, or run keyless with WILL_LLM=mock.')
    process.exit( 2 )
  }

  // The ping validates key + balance + reachability, which is the failure class
  // that strands an operator. It uses the pinned model when there is one, so a
  // bad model id is caught too.
  const base = process.env.WILL_LLM_BASE_URL ?? defaultBaseFor( mode )
  if( !base ){
    console.error(`[will] WILL_LLM=${ mode } has no known base URL — set WILL_LLM_BASE_URL.`)
    process.exit( 2 )
  }
  // The ping needs *a* model id. WILL_LLM_MODEL is the one the Will will
  // actually use, so preferring it means a bad id is caught here rather than at
  // the first tick. Without it there is nothing honest to send: the engine no
  // longer carries a default model, so say so plainly instead of guessing.
  const model = process.env.WILL_LLM_MODEL
  if( !model ){
    console.error(`[will] WILL_LLM_MODEL is not set. The engine has no default model —`)
    console.error('[will] pick one for your provider (e.g. WILL_LLM_MODEL=claude-sonnet-4-5-20250929).')
    process.exit( 2 )
  }

  // Ping in the provider's OWN dialect. This used to be hardcoded to the
  // Anthropic wire, which was fine when boot knew only anthropic and glm. With
  // the provider set widened it became a false negative: an OpenAI-wire
  // provider answers 404 to `/messages`, preflight read that as "the LLM
  // refused", and a perfectly working Will never got raised.
  const ping = pingRequest( knownWireFor( mode ) ?? 'openai', base, model, key, mode )
  if( !ping ){
    console.error(`[will] no preflight ping for the ${ mode } wire — raising the mind unchecked.`)
    return
  }
  try {
    const res = await fetch( ping.url, {
      method:  'POST',
      headers: ping.headers,
      body:    JSON.stringify( ping.body ),
      signal:  AbortSignal.timeout( 20_000 ),
    } )
    if( res.ok ) return

    const detail = ( await res.text().catch( () => '') ).slice( 0, 300 )
    const fatal  = res.status === 400 || res.status === 401 || res.status === 403
    if( !fatal ){
      console.error(`[will] the executive's LLM answered ${ res.status } on a test call — raising the mind anyway (it retries): ${ detail }`)
      return
    }
    console.error(`[will] the executive's LLM refused a test call (${ res.status }) — this Will would boot, perceive, and never speak:`)
    console.error(`       ${ detail }`)
    console.error('[will] fix the key / credit / model above, or run keyless with WILL_LLM=mock.')
    process.exit( 1 )
  }
  catch( e ){
    console.error(`[will] could not reach the executive's LLM: ${ ( e as Error ).message }`)
    console.error('[will] the Will would boot and stay silent. Check the network / WILL_LLM_BASE_URL, or run keyless with WILL_LLM=mock.')
    process.exit( 1 )
  }
}

export interface BootedWill {
  will:       Will
  name:       string
  pmaPath:    string
  tickMs:     number
  anatomy:    NonNullable<CreateWillOptions['anatomy']>
  /** Run before hibernate on shutdown (close servers/transports). LIFO. */
  onCleanup:  ( fn: () => Promise<void> | void ) => void
  /** Hibernate → persist → exit(0). Idempotent; SIGINT/SIGTERM already wired. */
  shutdown:   ( why: string ) => Promise<void>
}

/** Raise the mind from env config — wake from the artifact if one exists. */
export async function bootWillFromEnv(): Promise<BootedWill> {
  const name       = process.env.WILL_NAME ?? 'Will'
  const pmaPath    = resolve( process.env.WILL_PMA_PATH ?? `.will/${ slug( name ) }.pma.json`)
  const tickMs     = parseInt( process.env.WILL_TICK_MS ?? '1000')
  const anatomy = ( process.env.WILL_ANATOMY as CreateWillOptions['anatomy'] ) ?? 'mind'

  await preflightLLM( anatomy )

  const opts: Omit<CreateWillOptions, 'identity'> = {
    name, anatomy, tickMs,
    ...( process.env.WILL_LLM_MODEL ? { model: process.env.WILL_LLM_MODEL } : {} ),
    ...( process.env.WILL_LLM ? { llm: process.env.WILL_LLM as CreateWillOptions['llm'] } : {} ),
    ...( process.env.WILL_SEED ? { seed: parseInt( process.env.WILL_SEED ) } : {} ),
  }

  let will: Will
  if( existsSync( pmaPath ) ){
    const pma = JSON.parse( readFileSync( pmaPath, 'utf8') ) as PMASnapshot
    will = await Will.wake( pma, opts )
    console.error(`[will] ${ name } woke from ${ pmaPath }`)
    // A woken Will carries its own identity — that is the point of an artifact.
    // But an operator editing WILL_IDENTITY and seeing nothing change deserves
    // to know why, rather than concluding the persona layer is broken.
    if( process.env.WILL_IDENTITY )
      console.error(`[will] note: WILL_IDENTITY is ignored — ${ name } woke as itself. Delete ${ pmaPath } to be born fresh from it.`)
  }
  else {
    will = await Will.create( {
      ...opts,
      identity: { prompt: process.env.WILL_IDENTITY ?? `I am ${ name }, a persistent mind.` },
    } )
    console.error(`[will] ${ name } born (no artifact at ${ pmaPath } yet)`)
  }
  will.on('error', e => console.error(`[will] error: ${ e.message }`) )

  // Onward bridges: MCP servers whose tools become the Will's OWN abilities.
  // Best-effort — a bad entry warns and is skipped; the mind still boots.
  const cleanups: Array<() => Promise<void> | void> = []
  if( process.env.WILL_MCP_SERVERS ){
    try {
      const sources = JSON.parse( process.env.WILL_MCP_SERVERS ) as McpToolsSource[]
      for( const source of Array.isArray( sources ) ? sources : [] ){
        try {
          const { names, close } = await connectMcpEffectors( will, source )
          cleanups.push( close )
          console.error(`[will] ${ name } gained abilities: ${ names.join(', ') }`)
        }
        catch( e ){ console.error(`[will] MCP bridge failed (skipped): ${ ( e as Error ).message }`) }
      }
    }
    catch( e ){ console.error(`[will] WILL_MCP_SERVERS is not valid JSON — ignoring: ${ ( e as Error ).message }`) }
  }

  // Hibernate exactly once on the way out — cleanups (LIFO), distill + stop, persist.
  let leaving = false
  const shutdown = async ( why: string ): Promise<void> => {
    if( leaving ) return
    leaving = true
    for( const fn of cleanups.reverse() ) await Promise.resolve( fn() ).catch( () => {} )
    try {
      const pma = await will.hibernate()
      mkdirSync( dirname( pmaPath ), { recursive: true } )
      writeFileSync( pmaPath, JSON.stringify( pma ) )
      console.error(`[will] ${ name } hibernated to ${ pmaPath } (${ why })`)
    }
    catch( e ){ console.error(`[will] hibernate failed: ${ ( e as Error ).message }`) }
    process.exit( 0 )
  }
  process.on('SIGINT',  () => void shutdown('SIGINT') )
  process.on('SIGTERM', () => void shutdown('SIGTERM') )

  return {
    will, name, pmaPath, tickMs, anatomy,
    onCleanup: fn => cleanups.push( fn ),
    shutdown,
  }
}
