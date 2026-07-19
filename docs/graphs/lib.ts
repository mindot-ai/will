// ─────────────────────────────────────────────────────────────
// docs/graphs/lib.ts — the knowledge-graph design system
// ─────────────────────────────────────────────────────────────
//
// One renderer, one visual language: every architecture graph is generated
// from a declarative spec (groups, nodes, edges) so colors, typography and
// edge styling stay uniform across the whole set — and future graphs stay
// on-style by construction. `bun docs/graphs/generate.ts` re-emits the SVGs.
//
// Category colors are the SAME across every graph: a violet node is always
// memory, amber is always executive, green is always agency — a reader who
// learns the palette once can read every diagram.
// ─────────────────────────────────────────────────────────────

export const PALETTE = {
  regulatory: { color: '#2dd4bf', label: 'Regulatory (body)' },
  perceptual: { color: '#38bdf8', label: 'Perception & senses' },
  affective:  { color: '#fb7185', label: 'Affect (feeling)' },
  memory:     { color: '#a78bfa', label: 'Memory' },
  executive:  { color: '#fbbf24', label: 'Executive (System 2)' },
  agency:     { color: '#4ade80', label: 'Agency (action)' },
  meta:       { color: '#818cf8', label: 'Meta-cognition' },
  social:     { color: '#f472b6', label: 'Social cognition' },
  llm:        { color: '#f97316', label: 'LLM seam' },
  infra:      { color: '#94a3b8', label: 'Stem / infrastructure' },
  world:      { color: '#e2e8f0', label: 'Host / world' },
} as const

export type Cat = keyof typeof PALETTE

export interface GNode {
  id:    string
  x:     number
  y:     number
  w?:    number
  h?:    number
  label: string
  sub?:  string
  cat:   Cat
  /** Soft outer glow — reserve for LLM-recruitment nodes and capstone anchors. */
  glow?: boolean
}

export interface GGroup {
  x: number; y: number; w: number; h: number
  label: string
  cat:   Cat
}

type Side = 't' | 'b' | 'l' | 'r'

export interface GEdge {
  from:  string
  to:    string
  cat?:  Cat
  /** Dashed = feedback / learning / off-main-path. Solid = primary flow. */
  dash?: boolean
  label?: string
  fromSide?: Side
  toSide?:   Side
  /** 0..1 — how far along the path the label pill sits (default 0.5). */
  at?: number
  /** Extra control-point reach, for routing around neighbors. */
  reach?: number
  /** ABSOLUTE control extension (overrides the distance-based default + reach). */
  ext?: number
  /** One waypoint — the path threads through it (label pill sits here too). */
  via?: { x: number; y: number }
}

export interface Graph {
  file:     string
  title:    string
  subtitle: string
  width:    number
  height:   number
  legend:   Cat[]
  groups:   GGroup[]
  nodes:    GNode[]
  edges:    GEdge[]
}

const NODE_W = 172
const NODE_H = 54

const esc = ( s: string ): string =>
  s.replace( /&/g, '&amp;').replace( /</g, '&lt;').replace( />/g, '&gt;')

function anchor( n: Required<Pick<GNode, 'x' | 'y'>> & { w: number; h: number }, side: Side ): { x: number; y: number } {
  switch( side ){
    case 't': return { x: n.x + n.w / 2, y: n.y }
    case 'b': return { x: n.x + n.w / 2, y: n.y + n.h }
    case 'l': return { x: n.x,           y: n.y + n.h / 2 }
    case 'r': return { x: n.x + n.w,     y: n.y + n.h / 2 }
  }
}

/** Pick sides by dominant axis when the spec doesn't say. */
function autoSides( a: { cx: number; cy: number }, b: { cx: number; cy: number } ): [ Side, Side ] {
  const dx = b.cx - a.cx, dy = b.cy - a.cy
  if( Math.abs( dx ) >= Math.abs( dy ) ) return dx >= 0 ? [ 'r', 'l' ] : [ 'l', 'r' ]
  return dy >= 0 ? [ 'b', 't' ] : [ 't', 'b' ]
}

type Pt = { x: number; y: number }

function extFor( d: number, e: { ext?: number; reach?: number } ): number {
  return e.ext ?? ( Math.max( 34, Math.min( 120, d * 0.38 ) ) + ( e.reach ?? 0 ) )
}

function out( s: Side, p: Pt, ext: number ): Pt {
  return s === 'r' ? { x: p.x + ext, y: p.y } :
         s === 'l' ? { x: p.x - ext, y: p.y } :
         s === 'b' ? { x: p.x, y: p.y + ext } : { x: p.x, y: p.y - ext }
}

/** Point at parameter t on the cubic (for label placement). */
function bezierPoint( p0: Pt, c0: Pt, c1: Pt, p1: Pt, t: number ): Pt {
  const u = 1 - t
  return {
    x: u*u*u*p0.x + 3*u*u*t*c0.x + 3*u*t*t*c1.x + t*t*t*p1.x,
    y: u*u*u*p0.y + 3*u*u*t*c0.y + 3*u*t*t*c1.y + t*t*t*p1.y,
  }
}

/**
 * Build the edge path + its label anchor. Plain edges are one cubic; an edge
 * with `via` threads through the waypoint as two C1-continuous cubics (and the
 * label pill sits at the waypoint — that's what the waypoint is for).
 */
function edgePath(
  p0: Pt, s0: Side, p1: Pt, s1: Side,
  e: { ext?: number; reach?: number; via?: Pt; at?: number },
): { d: string; label: Pt } {
  if( e.via ){
    const v   = e.via
    const dir = ( () => {
      const dx = p1.x - p0.x, dy = p1.y - p0.y, m = Math.hypot( dx, dy ) || 1
      return { x: dx / m, y: dy / m }
    } )()
    const δ    = 60
    const vIn  = { x: v.x - dir.x * δ, y: v.y - dir.y * δ }
    const vOut = { x: v.x + dir.x * δ, y: v.y + dir.y * δ }
    const c0   = out( s0, p0, extFor( Math.hypot( v.x - p0.x, v.y - p0.y ), e ) )
    const c1   = out( s1, p1, extFor( Math.hypot( p1.x - v.x, p1.y - v.y ), e ) )
    return {
      d: `M ${p0.x} ${p0.y} C ${c0.x} ${c0.y}, ${vIn.x} ${vIn.y}, ${v.x} ${v.y} ` +
         `C ${vOut.x} ${vOut.y}, ${c1.x} ${c1.y}, ${p1.x} ${p1.y}`,
      label: v,
    }
  }
  const ext = extFor( Math.hypot( p1.x - p0.x, p1.y - p0.y ), e )
  const c0  = out( s0, p0, ext ), c1 = out( s1, p1, ext )
  return {
    d: `M ${p0.x} ${p0.y} C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${p1.x} ${p1.y}`,
    label: bezierPoint( p0, c0, c1, p1, e.at ?? 0.5 ),
  }
}

export function render( g: Graph ): string {
  const byId = new Map( g.nodes.map( n => [ n.id, { ...n, w: n.w ?? NODE_W, h: n.h ?? NODE_H } ] ) )
  const usedColors = new Set<string>()
  for( const e of g.edges ) usedColors.add( PALETTE[ e.cat ?? byId.get( e.from )!.cat ].color )

  const parts: string[] = []

  // ── canvas ──
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" font-family="ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">`,
    `<defs>`,
    `<radialGradient id="sky" cx="30%" cy="-10%" r="90%">` +
      `<stop offset="0%" stop-color="#151b28"/><stop offset="55%" stop-color="#0d1119"/><stop offset="100%" stop-color="#0a0d13"/></radialGradient>`,
    `<filter id="glow" x="-60%" y="-60%" width="220%" height="220%">` +
      `<feDropShadow dx="0" dy="0" stdDeviation="7" flood-opacity="0.55"/></filter>`,
  )
  for( const color of usedColors ){
    const id = `arr-${ color.slice( 1 ) }`
    parts.push(
      `<marker id="${id}" viewBox="0 0 10 10" refX="8.4" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">` +
      `<path d="M 0.8 1.2 L 8.8 5 L 0.8 8.8 L 3 5 Z" fill="${color}"/></marker>`)
  }
  parts.push(`</defs>`)
  parts.push(`<rect width="${g.width}" height="${g.height}" fill="url(#sky)"/>`)
  parts.push(`<rect x="1" y="1" width="${g.width - 2}" height="${g.height - 2}" rx="22" fill="none" stroke="#ffffff14" stroke-width="1.5"/>`)

  // ── header ──
  parts.push(
    `<text x="40" y="56" font-size="25" font-weight="700" fill="#f8fafc" letter-spacing="0.2">${esc( g.title )}</text>`,
    `<text x="40" y="80" font-size="13" fill="#8b93a7">${esc( g.subtitle )}</text>`,
  )

  // ── legend (top-right, right-aligned chips) ──
  {
    let cx = g.width - 40
    for( const cat of [ ...g.legend ].reverse() ){
      const { color, label } = PALETTE[ cat ]
      const w = 14 + label.length * 6.1 + 18
      cx -= w
      parts.push(
        `<rect x="${cx}" y="42" width="${w}" height="22" rx="11" fill="${color}14" stroke="${color}55" stroke-width="1"/>`,
        `<circle cx="${cx + 12}" cy="53" r="3.4" fill="${color}"/>`,
        `<text x="${cx + 21}" y="57" font-size="10.5" fill="#cbd5e1">${esc( label )}</text>`,
      )
      cx -= 8
    }
  }

  // ── groups ──
  for( const gr of g.groups ){
    const color = PALETTE[ gr.cat ].color
    parts.push(
      `<rect x="${gr.x}" y="${gr.y}" width="${gr.w}" height="${gr.h}" rx="16" fill="${color}07" stroke="${color}2e" stroke-width="1" stroke-dasharray="5 4"/>`,
      `<text x="${gr.x + 16}" y="${gr.y + 22}" font-size="10.5" font-weight="700" letter-spacing="1.6" fill="${color}bb">${esc( gr.label.toUpperCase() )}</text>`,
    )
  }

  // ── edges (under nodes) ──
  for( const e of g.edges ){
    const a = byId.get( e.from ), b = byId.get( e.to )
    if( !a || !b ) throw new Error(`${g.file}: edge ${e.from}→${e.to} references a missing node`)
    const [ autoA, autoB ] = autoSides( { cx: a.x + a.w/2, cy: a.y + a.h/2 }, { cx: b.x + b.w/2, cy: b.y + b.h/2 } )
    const sA = e.fromSide ?? autoA, sB = e.toSide ?? autoB
    const p0 = anchor( a, sA ), p1 = anchor( b, sB )
    const color = PALETTE[ e.cat ?? a.cat ].color
    const { d, label: m } = edgePath( p0, sA, p1, sB, e )
    parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-opacity="0.85"` +
      `${ e.dash ? ' stroke-dasharray="5 4"' : '' } marker-end="url(#arr-${ color.slice( 1 ) })"/>`,
    )
    if( e.label ){
      const w = e.label.length * 5.6 + 16
      parts.push(
        `<rect x="${m.x - w/2}" y="${m.y - 10}" width="${w}" height="19" rx="9.5" fill="#0b0e14" fill-opacity="0.92" stroke="${color}44" stroke-width="0.8"/>`,
        `<text x="${m.x}" y="${m.y + 3.5}" font-size="10" fill="#cbd5e1" text-anchor="middle">${esc( e.label )}</text>`,
      )
    }
  }

  // ── nodes ──
  for( const n of g.nodes ){
    const { color } = PALETTE[ n.cat ]
    const w = n.w ?? NODE_W, h = n.h ?? NODE_H
    parts.push(`<g${ n.glow ? ` filter="url(#glow)" color="${color}"` : '' }>`)
    parts.push(
      `<rect x="${n.x}" y="${n.y}" width="${w}" height="${h}" rx="12" fill="#10141d" stroke="${color}99" stroke-width="1.4"/>`,
      `<rect x="${n.x}" y="${n.y}" width="${w}" height="${h}" rx="12" fill="${color}12"/>`,
      `<rect x="${n.x + 1.2}" y="${n.y + 9}" width="3.2" height="${h - 18}" rx="1.6" fill="${color}"/>`,
    )
    const cx = n.x + w / 2
    if( n.sub ){
      parts.push(
        `<text x="${cx}" y="${n.y + h/2 - 3}" font-size="13" font-weight="600" fill="#f1f5f9" text-anchor="middle">${esc( n.label )}</text>`,
        `<text x="${cx}" y="${n.y + h/2 + 13.5}" font-size="10" fill="#8b93a7" text-anchor="middle">${esc( n.sub )}</text>`,
      )
    }
    else
      parts.push(`<text x="${cx}" y="${n.y + h/2 + 4.5}" font-size="13" font-weight="600" fill="#f1f5f9" text-anchor="middle">${esc( n.label )}</text>`)
    parts.push(`</g>`)
  }

  // ── footer ──
  parts.push(
    `<text x="40" y="${g.height - 22}" font-size="10.5" fill="#5b6372">@mindot/will · ${esc( g.file.replace('.svg', '') )}</text>`,
    `<text x="${g.width - 40}" y="${g.height - 22}" font-size="10.5" fill="#454c59" text-anchor="end">regenerate: bun docs/graphs/generate.ts</text>`,
    `</svg>`,
  )
  return parts.join('\n')
}
