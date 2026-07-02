// ─────────────────────────────────────────────────────────────
// src/agency/access.grants.ts  —  the access-grant layer
// ─────────────────────────────────────────────────────────────
//
// The agency-native permission primitive. It replaces the permission/sense-gate
// role the legacy effectorRegistry used to carry (the catalog/discovery/created-
// effector machinery is retired separately). A Will's communication surface is
// closed by default: `listen`, `talk`, `text`, `gesture`, `broadcast` each
// require an explicit grant; everything else is freely available.
//
// Semantics are preserved verbatim from effectorRegistry's permission methods so
// the migration is behaviour-identical:
//   • non-explicit name      → always allowed
//   • explicit name granted  → allowed
//   • explicit name ungranted→ denied
//
// The backend's `PATCH /v1/wills/:id/effectors` reaches this via the unchanged
// `WillStem.setAllowedEffectors` → effectorController → `setAllowed`.
// ─────────────────────────────────────────────────────────────

/** The communication surface — these names are denied unless explicitly granted. */
export const EXPLICIT_EFFECTORS: ReadonlySet<string> = new Set( [
  'listen', 'talk', 'text', 'gesture', 'broadcast',
] )

export class AccessGrants {
  private _granted: Set<string>

  /** Seed from the resolved allow-list (e.g. profile effectors). null/[] ⇒ none granted. */
  constructor( initial?: string[] | null ){
    this._granted = new Set( ( initial ?? [] ).filter( n => EXPLICIT_EFFECTORS.has( n ) ) )
  }

  /** Is the Will permitted to use this effector/schema right now? */
  isAllowed( name: string ): boolean {
    if( !EXPLICIT_EFFECTORS.has( name ) ) return true
    return this._granted.has( name )
  }

  /** Grant one explicit effector (no-op for non-explicit names). */
  allow( name: string ): void {
    if( EXPLICIT_EFFECTORS.has( name ) ) this._granted.add( name )
  }

  /** Revoke one effector. */
  revoke( name: string ): void {
    this._granted.delete( name )
  }

  /** Replace the entire grant set (runtime reconfiguration). */
  setAllowed( names: string[] | null ): void {
    this._granted = new Set( ( names ?? [] ).filter( n => EXPLICIT_EFFECTORS.has( n ) ) )
  }

  /** The currently granted explicit effectors. */
  granted(): string[] {
    return [ ...this._granted ]
  }
}
