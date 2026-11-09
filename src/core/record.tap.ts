// ─────────────────────────────────────────────────────────────
// src/core/record.tap.ts
// ─────────────────────────────────────────────────────────────
//
// RECORD_ANCHORING — where each record a Will produces is handed to its record
// chain, at the same four capture sites the replay recorders use.
//
// A tap of its own, beside the recorders rather than one of them: each recorder
// registry holds one sink per Will, and `ReplayController.start` replaces it, so
// a chain installed as a recorder would displace a replay recording or be
// displaced by one. A capture site hands its record to both.
//
// Keyed by willId, like the recorder registries. `chain` is not a stream a
// capture site produces; the anchor controller writes it.
// ─────────────────────────────────────────────────────────────

import type { RecordStream } from '#core/record.chain'

export type TappedStream = Exclude<RecordStream, 'chain'>

export type RecordTap = ( stream: TappedStream, record: unknown ) => void

const _taps = new Map<string, RecordTap>()

export function setRecordTap( willId: string, tap: RecordTap ): void {
  _taps.set( willId, tap )
}

export function clearRecordTap( willId: string ): void {
  _taps.delete( willId )
}

export function getRecordTap( willId: string ): RecordTap | undefined {
  return _taps.get( willId )
}
