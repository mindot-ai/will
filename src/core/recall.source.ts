// ─────────────────────────────────────────────────────────────
// src/core/recall.source.ts
// ─────────────────────────────────────────────────────────────
//
// Semantic recall is the mind's second oracle. A recall embeds its query —
// often over a network — and answers at a wall-clock moment, or times out; what
// it returns decides what the mind remembers in that moment. So each recall's
// answer is chained where it arrived (`recall`), and a replay re-feeds it from
// there instead of searching again (RECORD_ANCHORING step 4).
//
// Keyed by willId, like the completion and inbound seams.
// ─────────────────────────────────────────────────────────────

/** One hit, as the search answered it. */
export interface RecallHit {
  episodeId:  string
  similarity: number
  page?:      number
}

/** A recall's answer: its hits, or that it timed out and gave none. */
export interface RecallRecord {
  /** What was asked, as the mind asked it. */
  query:          unknown
  limit:          number
  minSimilarity?: number
  hits:           RecallHit[]
  timedOut?:      true
}

/** Hands a replay's recalls back their recorded answers, when the replay says. */
export interface RecallSource {
  nextRecall( query: unknown ): Promise<RecallRecord>
}

const _sources = new Map<string, RecallSource>()

export function setRecallSource( willId: string, source: RecallSource ): void { _sources.set( willId, source ) }
export function clearRecallSource( willId: string ): void { _sources.delete( willId ) }
export function getRecallSource( willId: string ): RecallSource | undefined { return _sources.get( willId ) }
