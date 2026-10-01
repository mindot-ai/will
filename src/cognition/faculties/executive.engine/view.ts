// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/view.ts
// ─────────────────────────────────────────────────────────────
//
// What one LLM call is shown, against the window it is sent into (LOSSLESS P5a).
//
// The engine had no notion of a context window, which was safe only while nothing
// large arrived. P2 made what an act brings back whole, and it reaches every
// prompt: an MCP tool's output becomes a percept's data and a working-memory
// item's, rendered in every master and facet call while it lives. One 30-PR
// listing is ~135k tokens; GLM-5.2's default window is ~203k.
//
// So an item larger than a page is a document, not a line: it renders as a header
// and a page, and the rest is reachable whole by `[RECALL]` — never cut. Pages are
// deterministic and concatenate back to the whole, byte for byte.
//
// Everything here is a pure function of the prompt's own inputs. A prompt is
// matched byte for byte on replay (RecordedCompletionSource), so the estimate is
// arithmetic, never the provider's count: that arrives after the call.
// ─────────────────────────────────────────────────────────────

/** The window assumed when the host declares none (LOSSLESS_P5 D2). */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * One page of an item, in tokens. Fixed, so a page number names the same text in
 * every call: a mind told "page 2 of 17" on one call and handed a differently
 * sized page 2 on the next would skip or re-read. What a call's budget decides is
 * only what shows INLINE (`CallView.inlineTokens`).
 */
export const PAGE_TOKENS = 8_000
/** The safety net halves what shows inline down to this, then stops. */
const INLINE_TOKENS_MIN = 250
/** Share of the window held back from the estimate's error. */
const RESERVE = 0.05
/** Bytes of UTF-8 per token the estimate assumes. Measured on 242 of Lora's master
 *  calls: 3.72–4.42 characters per token on prose. JSON, ids and code tokenize
 *  denser, so 3 is the margin. */
const BYTES_PER_TOKEN = 3

const encoder = new TextEncoder()

/** Deterministic token estimate for budgeting — conservative, never the provider's count. */
export function estimateTokens( text: string ): number {
  return Math.ceil( encoder.encode( text ).length / BYTES_PER_TOKEN )
}

/** What a call may spend on its user message, and how big one page of an item is. */
export interface CallView {
  /** The routed model's context window, in tokens. */
  window:     number
  /** Tokens the user message may take: window − output ceiling − system prompt − reserve. */
  budget:     number
  /** An item's data shows whole, inline, up to this many tokens; above it, it is a document. */
  inlineTokens: number
  /**
   * 'page': an oversize item shows its header and its first page.
   * 'reference': only its header — the safety net's first step, when the call
   * would not otherwise fit.
   */
  mode:       'page' | 'reference'
}

export function callView( window: number, maxOutputTokens: number, systemPrompt: string ): CallView {
  const budget = Math.max( 0, window - maxOutputTokens - estimateTokens( systemPrompt ) - Math.ceil( window * RESERVE ) )
  return { window, budget, inlineTokens: PAGE_TOKENS, mode: 'page' }
}

/**
 * Build a call's user message within its budget. Over budget, the view tightens a
 * step at a time — oversize items to their headers, then less inline — and is
 * rebuilt; nothing is cut, only moved behind a handle. Returns the message, the
 * view it was built with, and whether it had to tighten (an operator's record).
 */
export function fitToBudget( view: CallView, build: ( v: CallView ) => string ): { message: string; view: CallView; tightened: number; overBudget: boolean } {
  let v = view, message = build( v ), tightened = 0
  while( estimateTokens( message ) > v.budget ){
    if( v.mode === 'page') v = { ...v, mode: 'reference' }
    else if( v.inlineTokens > INLINE_TOKENS_MIN ) v = { ...v, inlineTokens: Math.max( INLINE_TOKENS_MIN, Math.floor( v.inlineTokens / 2 ) ) }
    else break
    tightened++
    message = build( v )
  }
  return { message, view: v, tightened, overBudget: estimateTokens( message ) > v.budget }
}

// ── an item as text, and its pages ───────────────────────────

/**
 * An item's data as the text a page is cut from. A string is itself; an array is
 * one element per line, so a page boundary falls between elements; anything else
 * is pretty-printed JSON. A host's own `summary` is left out, as `perceptData`
 * always has: it is already the label on the line above.
 */
export function itemText( data: unknown ): string {
  if( typeof data === 'string') return data
  if( Array.isArray( data ) ) return `[\n${ data.map( d => JSON.stringify( d ) ).join(',\n') }\n]`
  if( data && typeof data === 'object'){
    const shown = Object.fromEntries( Object.entries( data as Record<string, unknown> ).filter( ( [ k ] ) => k !== 'summary') )
    return JSON.stringify( shown, null, 2 )
  }
  return String( data )
}

/**
 * Split an item's text into pages of about `pageTokens`. Pages break at a line;
 * a single line longer than a page breaks at the last comma or space in the page's
 * final quarter, else exactly at the page's end. Deterministic, and
 * `pages.join('') === text` — nothing is dropped, only placed on another page.
 */
export function paginate( text: string, pageTokens: number ): string[] {
  const size = Math.max( 1, pageTokens * BYTES_PER_TOKEN )
  if( encoder.encode( text ).length <= size ) return [ text ]

  const pages: string[] = []
  let page = '', pageBytes = 0
  const flush = () => { if( page ){ pages.push( page ); page = ''; pageBytes = 0 } }

  // Keep each line's own newline, so the pages rejoin to the text exactly.
  for( const line of text.match( /[^\n]*\n|[^\n]+$/g ) ?? [] ){
    const bytes = encoder.encode( line ).length
    if( pageBytes + bytes <= size ){ page += line; pageBytes += bytes; continue }
    flush()
    if( bytes <= size ){ page = line; pageBytes = bytes; continue }

    // One line longer than a page — minified JSON, a long paragraph.
    let rest = line
    while( encoder.encode( rest ).length > size ){
      const head = sliceBytes( rest, size )
      const floor = Math.floor( head.length * 0.75 )
      const soft = Math.max( head.lastIndexOf(','), head.lastIndexOf(' ') )
      const cut = soft >= floor ? soft + 1 : head.length
      pages.push( rest.slice( 0, cut ) )
      rest = rest.slice( cut )
    }
    page = rest; pageBytes = encoder.encode( rest ).length
  }
  flush()
  return pages
}

/** The longest prefix of `s` within `bytes` bytes of UTF-8, never splitting a character. */
function sliceBytes( s: string, bytes: number ): string {
  let used = 0, i = 0
  for( const ch of s ){
    const b = encoder.encode( ch ).length
    if( used + b > bytes ) break
    used += b; i += ch.length
  }
  return s.slice( 0, Math.max( 1, i ) )
}

function humanSize( text: string ): string {
  const bytes = encoder.encode( text ).length
  return bytes < 1024 ? `${ bytes } B`
       : bytes < 1024 * 1024 ? `${ ( bytes / 1024 ).toFixed( 1 ) } KB`
       : `${ ( bytes / 1024 / 1024 ).toFixed( 1 ) } MB`
}

const recallHint = ( handle: string, page: number ) =>
  `{"recall": [{"doc": "${ handle }", "page": ${ page }}]}`

/**
 * An item's data on one line, as prompts have always shown it — a string as it
 * is, anything else as compact JSON, a host's own `summary` left out (it is the
 * label on the line above). '' when there is nothing to show.
 */
export function compactText( data: unknown ): string {
  if( data === undefined || data === null ) return ''
  if( typeof data === 'string') return data
  try {
    const shown = Array.isArray( data )
      ? data
      : Object.fromEntries( Object.entries( data as Record<string, unknown> ).filter( ( [ k ] ) => k !== 'summary') )
    const json = JSON.stringify( shown )
    return json === '{}' || json === '[]' ? '' : json
  }
  catch { return '' }
}

/**
 * An item's data as a prompt shows it: whole, on its line, when it fits one page;
 * otherwise its size, its handle and — in 'page' mode — its first page, with the
 * way to the rest. Without a view (a caller that has no window) it is whole.
 */
export function renderItemData( data: unknown, handle: string | undefined, view: CallView | undefined ): string {
  const compact = compactText( data )
  if( compact === '') return ''
  if( !view || !handle || estimateTokens( compact ) <= view.inlineTokens ) return `\n    ${ compact }`

  const text  = itemText( data )
  const pages = paginate( text, PAGE_TOKENS )
  const size  = `${ humanSize( text ) } ≈ ${ estimateTokens( text ).toLocaleString('en-US') } tokens, ${ pages.length } pages · doc:${ handle }`
  if( view.mode === 'reference')
    return `\n    [${ size } — whole in memory, not shown here; ${ recallHint( handle, 1 ) } to read it]`
  if( pages.length === 1 )   // larger than this call shows inline, but a single page
    return `\n    [${ size } — whole in memory, not shown here; ${ recallHint( handle, 1 ) } to read it]`
  return `\n    [${ size } — page 1 of ${ pages.length } below; the rest is whole in memory: ${ recallHint( handle, 2 ) }]\n${ pages[0] }`
}

// ── what she asked to have brought back ──────────────────────

/** One `[RECALL]` request, resolved to what the mind holds. */
export interface BroughtBack {
  handle:  string
  page:    number
  /** The item's own label — what it was when it arrived. */
  label?:  string
  /** How it arrived: `reafferent` (what I found by acting), `exafferent`, … */
  provenance?: string
  /** The act it answered, when reafferent. */
  sourceIntentId?: string
  /** Tick it arrived. */
  tick?:   number
  /** The item's data; undefined when the mind holds no record of the handle. */
  data?:   unknown
}

/**
 * `## Brought Back (I asked for these)` — the pages the mind asked for last cycle,
 * whole. NOT a percept and NOT working memory: remembering consults no world, so
 * it is neither afference nor an act (LOSSLESS_P5 § agency rules). Each keeps the
 * provenance it arrived with. Rendered within `budget` tokens, in the order asked;
 * what does not fit this call is said so, not dropped.
 */
export function renderBroughtBack( items: readonly BroughtBack[], budget: number ): string {
  if( items.length === 0 ) return ''
  const out: string[] = []
  let used = 0
  let deferred = 0

  for( const it of items ){
    if( it.data === undefined ){
      out.push(`- doc:${ it.handle } — I hold no record of it now (it may have been forgotten).`)
      continue
    }
    const pages = paginate( itemText( it.data ), PAGE_TOKENS )
    const origin = [
      it.provenance === 'reafferent' ? 'what I found by acting' : it.provenance ? `${ it.provenance }` : undefined,
      it.label, it.tick !== undefined ? `tick ${ it.tick }` : undefined,
    ].filter( Boolean ).join(' · ')
    if( it.page < 1 || it.page > pages.length ){
      out.push(`- doc:${ it.handle } (${ origin }) has ${ pages.length } page${ pages.length === 1 ? '' : 's' }; there is no page ${ it.page }.`)
      continue
    }
    const text = pages[ it.page - 1 ]!
    const cost = estimateTokens( text )
    if( used > 0 && used + cost > budget ){ deferred++; continue }
    used += cost
    const next = it.page < pages.length ? `\n→ the next: ${ recallHint( it.handle, it.page + 1 ) }` : '\n→ that was the last page.'
    out.push(`- doc:${ it.handle } (${ origin }) — page ${ it.page } of ${ pages.length }:\n${ text }${ next }`)
  }

  const tail = deferred > 0
    ? `\n${ deferred } more page${ deferred === 1 ? '' : 's' } I asked for did not fit this call — I can ask for ${ deferred === 1 ? 'it' : 'them' } again.`
    : ''
  return `## Brought Back (I asked for these)\nFrom my own memory, as it arrived — not something new:\n${ out.join('\n\n') }${ tail }`
}
