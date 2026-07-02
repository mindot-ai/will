// ─────────────────────────────────────────────────────────────
// src/stem/tracts/biography.writer.ts  —  per-Will session-biography writers
// ─────────────────────────────────────────────────────────────
//
// BiographyWriter owns the session-biography disk writers extracted from
// WillStem (R5-f): the behavioral session summary and the emotional
// biography (real-time spike/sustained-arousal events + end-of-session
// summary). All output is appended as JSONL under
// `data/wills/{willId}/profiles/`.
//
// WillStem calls these from its lifecycle (pause/archive) and tick loop
// (emotion-spike detection). The writers read (and, for the emotional
// summary, flush) the instance's `_sessionBehavior` aggregate; they touch
// only WillInstance fields, so they take the resolved instance directly
// and derive the Will id from `instance.config.id`.
//
// Behaviour is preserved verbatim from the original WillStem methods;
// this is a pure extract-collaborator refactor.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileLoggingEnabled } from '#stem/tracts/transport/stream.transport'
import type { WillInstance } from '#stem/index'

export class BiographyWriter {
  /** Profile dirs already ensured this process — avoids an mkdir syscall per write. */
  private readonly _ensuredDirs = new Set<string>()

  /**
   * Append one JSONL record to a Will's profiles/ dir. Dev-only (gated by
   * `fileLoggingEnabled()`, matching SessionLogger) — in production this concern
   * rides the `session_log`/transport path, not ephemeral local disk. The dir is
   * ensured once per process, not per write.
   */
  private _append( willId: string, file: string, record: unknown ): void {
    if( !fileLoggingEnabled() ) return

    const dataDir = process.env[ 'WILL_DATA_DIR' ] ?? './data'
    const dir     = join( dataDir, 'wills', willId, 'profiles' )
    try {
      if( !this._ensuredDirs.has( dir ) ){
        mkdirSync( dir, { recursive: true } )
        this._ensuredDirs.add( dir )
      }
      appendFileSync( join( dir, file ), JSON.stringify( record ) + '\n', 'utf8' )
    } catch( err ){
      logger.error( `[biography] ${file} write failed:`, err )
    }
  }
  /**
   * Compute and append a behavioral session summary to `behavioral.jsonl`.
   * Captures action distribution, top/novel/impulsive action counts, avg
   * confidence, valence/arousal ranges, and goal completion for the session.
   * Topics discussed (TODO 7.2) intentionally omitted — requires NLP analysis
   * on conversation content not available in state metrics.
   */
  writeSessionSummary( instance: WillInstance ): void {
    const sb = instance._sessionBehavior
    if( !sb ) return

    const willId = instance.config.id

    // Action type distribution from the agency repertoire's enactment counts.
    const actionDist: Record<string, number> = {}
    for( const skill of instance.cognition.schemaRepertoire.skills().values() )
      if( skill.enactments > 0 ) actionDist[ skill.schema ] = skill.enactments

    const topAction = Object.entries( actionDist )
      .sort( ( a, b ) => b[1] - a[1] )[ 0 ]?.[ 0 ] ?? 'none'

    // Action types tried exactly once signal exploratory/novel behavior
    const novelActionCount = Object.values( actionDist ).filter( c => c === 1 ).length

    const avgConfidence = sb.confidenceCount > 0
      ? sb.confidenceSum / sb.confidenceCount
      : null

    const completionRate = sb.goalsTotal > 0
      ? sb.goalsCompleted / sb.goalsTotal
      : null

    const summary = {
      type:                'session_summary',
      wallTime:            Date.now(),
      sessionId:           instance.sessionLogger?.sessionId ?? 'unknown',
      willId,
      startTick:           sb.startTick,
      endTick:             instance.tickCount,
      tickCount:           instance.tickCount - sb.startTick,
      actionDist,
      topAction,
      avgConfidence,
      novelActionCount,
      impulsiveActionCount: sb.impulsiveActionCount,
      valenceRange:        { min: sb.valenceMin,  max: sb.valenceMax,  spread: sb.valenceMax  - sb.valenceMin  },
      arousalRange:        { min: sb.arousalMin,  max: sb.arousalMax,  spread: sb.arousalMax  - sb.arousalMin  },
      goalsTotal:          sb.goalsTotal,
      goalsCompleted:      sb.goalsCompleted,
      completionRate,
    }

    this._append( willId, 'behavioral.jsonl', summary )
  }

  /**
   * Append one emotional event entry to `emotional_biography.jsonl`.
   * Called real-time on spike detection and sustained-arousal episode end.
   *
   * @param evtType  'spike' | 'sustained_high_arousal'
   * @param fields   Event-specific fields (tick, dimension, from/to/delta, etc.)
   */
  writeEmotionalEvent(
    instance: WillInstance,
    evtType:  'spike' | 'sustained_high_arousal',
    fields:   Record<string, unknown>
  ): void {
    const willId = instance.config.id

    const entry = {
      type:      evtType,
      wallTime:  Date.now(),
      sessionId: instance.sessionLogger?.sessionId ?? 'unknown',
      willId,
      ...fields,
    }

    this._append( willId, 'emotional_biography.jsonl', entry )
  }

  /**
   * Compute and append a session emotional biography summary to
   * `emotional_biography.jsonl`. Called at session end (pause or archive).
   * Flushes any open sustained-arousal streak, then writes a `session_summary`
   * entry covering dominant mood, valence/arousal arcs, spike count, and the
   * number of completed sustained-high-arousal episodes.
   *
   * PMA tooling can read across all `session_summary` entries to build a cross-
   * session emotional biography.
   */
  writeEmotionalBiographySummary( instance: WillInstance ): void {
    const sb = instance._sessionBehavior
    if( !sb || sb.avgValenceCount === 0 ) return

    const willId = instance.config.id

    // Flush any open sustained-arousal streak before writing the summary.
    if( sb.highArousalStreak >= 10 ){
      sb.sustainedEpisodes++
      this.writeEmotionalEvent( instance, 'sustained_high_arousal', {
        startTick:     instance.tickCount - sb.highArousalStreak,
        durationTicks: sb.highArousalStreak,
        tick:          instance.tickCount,
      })
      sb.highArousalStreak = 0
    }

    const avgValence    = sb.avgValenceSum / sb.avgValenceCount
    const dominantMood  = avgValence > 0.15 ? 'positive' : avgValence < -0.10 ? 'negative' : 'neutral'

    const summary = {
      type:                         'session_summary',
      wallTime:                     Date.now(),
      sessionId:                    instance.sessionLogger?.sessionId ?? 'unknown',
      willId,
      startTick:                    sb.startTick,
      endTick:                      instance.tickCount,
      tickCount:                    instance.tickCount - sb.startTick,
      dominantMood,
      avgValence:                   Math.round( avgValence * 1000 ) / 1000,
      valenceArc: {
        start: Math.round( sb.valenceStart * 1000 ) / 1000,
        end:   Math.round( sb.valenceEnd   * 1000 ) / 1000,
        min:   Math.round( sb.valenceMin   * 1000 ) / 1000,
        max:   Math.round( sb.valenceMax   * 1000 ) / 1000,
      },
      arousalArc: {
        start: Math.round( sb.arousalStart * 1000 ) / 1000,
        end:   Math.round( sb.arousalEnd   * 1000 ) / 1000,
        min:   Math.round( sb.arousalMin   * 1000 ) / 1000,
        max:   Math.round( sb.arousalMax   * 1000 ) / 1000,
      },
      spikeCount:                         sb.spikeCount,
      sustainedHighArousalEpisodes:        sb.sustainedEpisodes,
    }

    this._append( willId, 'emotional_biography.jsonl', summary )
  }
}
