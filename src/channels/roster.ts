// ─────────────────────────────────────────────────────────────
// src/channels/roster.ts — who the Will knows on a platform, and where
// ─────────────────────────────────────────────────────────────
//
// The mind knows *entities*; a platform knows user ids and channels. The roster
// is the durable seam between them: for each entity the Will has met on a
// channel it records how to reach them again — so a *proactive* utterance
// (`message.to` from the mind's own initiative) can find its person after a
// restart, not just within one session.
//
// It persists as a small JSON file next to the PMA artifact. Writes are
// throttled (the file is advisory routing state, not cognition — losing the
// last few seconds costs a fallback delivery, never memory).
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** How to reach one entity on the platform. */
export interface RosterEntry {
  /** The mind-side entity id, e.g. 'discord:80351110224678912'. */
  entityId: string
  /** The platform-side user id. */
  userId: string
  /** Last display name seen (advisory — the *learned* name lives in the mind). */
  displayName?: string
  /** DM channel id, once one is known. */
  dmChannelId?: string
  /** Last shared (guild) channel this entity spoke in. */
  lastChannelId?: string
  /** Epoch ms of the last message seen from them. */
  lastSeenAt: number
}

const FLUSH_MS = 2_000

export class ChannelRoster {
  private entries = new Map<string, RosterEntry>()
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor( private readonly path: string ) {
    if( existsSync( path ) ){
      try {
        const raw = JSON.parse( readFileSync( path, 'utf8' ) ) as RosterEntry[]
        for( const e of Array.isArray( raw ) ? raw : [] ) this.entries.set( e.entityId, e )
      }
      catch { /* a corrupt roster is not worth failing a boot over — start fresh */ }
    }
  }

  /** Upsert what we just learned about an entity; schedules a throttled flush. */
  record( update: { entityId: string; userId: string } & Partial<Omit<RosterEntry, 'entityId' | 'userId'>> ): RosterEntry {
    const prev = this.entries.get( update.entityId )
    const next: RosterEntry = {
      lastSeenAt: Date.now(),
      ...prev,
      ...Object.fromEntries( Object.entries( update ).filter( ( [ , v ] ) => v !== undefined ) ) as typeof update,
    }
    this.entries.set( next.entityId, next )
    this.dirty = true
    if( !this.timer ){
      this.timer = setTimeout( () => { this.timer = null; this.flush() }, FLUSH_MS )
      this.timer.unref?.()
    }
    return next
  }

  resolve( entityId: string ): RosterEntry | undefined {
    return this.entries.get( entityId )
  }

  all(): RosterEntry[] {
    return [ ...this.entries.values() ]
  }

  /** Write to disk now (no-op when clean). Called by bridges on close. */
  flush(): void {
    if( !this.dirty ) return
    try {
      mkdirSync( dirname( this.path ), { recursive: true } )
      writeFileSync( this.path, JSON.stringify( this.all(), null, 2 ) )
      this.dirty = false
    }
    catch { /* advisory state — never take the mind down over it */ }
  }
}
