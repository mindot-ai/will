// ─────────────────────────────────────────────────────────────
// src/surface/host/utterances.ts — a host-side tap on a Will's speech
// ─────────────────────────────────────────────────────────────
//
// Hosts that expose a Will over a request/response protocol (MCP tools, HTTP
// long-polls) share a timing problem: the Will may speak BETWEEN two calls —
// after a perceive round trip returns and before the caller asks for the next
// utterance. The tap buffers projections so nothing is lost in the gap, and
// `next()` gives the MCP/HTTP hosts one shared, honest await: drain the buffer
// first, else wait, else report silence (null — a choice, never an error).
// ─────────────────────────────────────────────────────────────

import type { Will, WillMessage } from '#surface/sdk/will'

const BUFFER_CAP = 50

export class UtteranceTap {
  private readonly _will: Will
  private readonly _pending: WillMessage[] = []

  constructor( will: Will ){
    this._will = will
    will.on('message', m => {
      this._pending.push( m )
      if( this._pending.length > BUFFER_CAP ) this._pending.shift()
    } )
  }

  /** Consume the oldest buffered utterance (optionally only one addressed to `to`). */
  takeBuffered( to?: string ): WillMessage | undefined {
    if( this._pending.length === 0 ) return undefined
    const i = to === undefined ? 0 : this._pending.findIndex( m => m.to === to )
    if( i < 0 ) return undefined
    return this._pending.splice( i, 1 )[0]
  }

  /**
   * The next utterance: a buffered one if a projection already landed, else
   * await up to `within` ms. `null` = the Will chose silence. An awaited
   * message is also consumed from the buffer so it never replays.
   */
  async next( within: number, to?: string ): Promise<WillMessage | null> {
    const buffered = this.takeBuffered( to )
    if( buffered ) return buffered

    const msg = await this._will.nextUtterance( { within, ...( to ? { to } : {} ) } )
    if( msg ){
      const i = this._pending.findIndex( p => p.id === msg.id )
      if( i >= 0 ) this._pending.splice( i, 1 )
    }
    return msg
  }
}
