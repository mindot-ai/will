// ─────────────────────────────────────────────────────────────
// src/cognition/schema.registry.ts
// ─────────────────────────────────────────────────────────────

export interface CognitiveEventSchema {
  readonly type: string
  readonly version: number
  validate( payload: unknown ): string | null  // null = valid, string = error message
}

// Migration transform: takes old payload, returns upgraded payload or error string
export type MigrationTransform = ( payload: unknown ) => { ok: true; payload: unknown } | { ok: false; error: string }

interface Migration {
  fromVersion: number
  toVersion: number
  transform: MigrationTransform
}

export class SchemaRegistry {
  private _schemas    = new Map<string, Map<number, CognitiveEventSchema>>()
  private _migrations = new Map<string, Migration[]>()

  register( schema: CognitiveEventSchema ): void {
    let versions = this._schemas.get( schema.type )
    if( !versions ){
      versions = new Map()
      this._schemas.set( schema.type, versions )
    }

    if( versions.has( schema.version ) )
      throw new Error(`Schema already registered: ${schema.type} v${schema.version}`)

    versions.set( schema.version, schema )
  }

  /**
   * Register a migration path from one schema version to the next.
   * Migrations must be registered in ascending order and cover contiguous versions.
   * The bus will auto-upgrade old payloads to the latest version on validate().
   */
  registerMigration( type: string, fromVersion: number, toVersion: number, transform: MigrationTransform ): void {
    if( toVersion !== fromVersion + 1 )
      throw new Error(`Migration must be to the next consecutive version (got ${fromVersion}→${toVersion})`)

    let migrations = this._migrations.get( type )
    if( !migrations ){
      migrations = []
      this._migrations.set( type, migrations )
    }
    migrations.push({ fromVersion, toVersion, transform })
    migrations.sort( ( a, b ) => a.fromVersion - b.fromVersion )
  }

  /**
   * Validate payload at a given version. If the exact version is not registered
   * but a migration path exists to a newer version, auto-upgrade and validate
   * against the latest registered version.
   */
  validate( type: string, version: number, payload: unknown ): string | null {
    const versions = this._schemas.get( type )
    if( !versions ) return `Unknown event type: ${type}`

    // Exact version match — fast path
    const exact = versions.get( version )
    if( exact ) return exact.validate( payload )

    // Try to migrate up to a known version
    const migrated = this._migrate( type, version, payload )
    if( !migrated.ok ) return migrated.error

    const target = versions.get( migrated.targetVersion )
    if( !target ) return `Unknown version ${version} for event type: ${type} (migration failed to find target)`

    return target.validate( migrated.payload )
  }

  /**
   * Public migration API used by the bus for per-subscriber version filtering.
   * Attempts to migrate payload from fromVersion up to a registered version.
   */
  tryMigrate(
    type: string,
    fromVersion: number,
    payload: unknown
  ): { ok: true; payload: unknown; targetVersion: number } | { ok: false; error: string } {
    return this._migrate( type, fromVersion, payload )
  }

  private _migrate(
    type: string,
    fromVersion: number,
    payload: unknown
  ): { ok: true; payload: unknown; targetVersion: number } | { ok: false; error: string } {
    const migrations = this._migrations.get( type )
    if( !migrations || migrations.length === 0 )
      return { ok: false, error: `Unknown version ${fromVersion} for event type: ${type}` }

    let current = payload
    let version = fromVersion

    for( const migration of migrations ){
      if( migration.fromVersion !== version ) continue
      const result = migration.transform( current )
      if( !result.ok ) return { ok: false, error: `Migration ${type} v${version}→v${migration.toVersion} failed: ${result.error}` }
      current = result.payload
      version = migration.toVersion
    }

    return { ok: true, payload: current, targetVersion: version }
  }

  hasType( type: string ): boolean {
    return this._schemas.has( type )
  }

  getVersions( type: string ): number[] {
    const versions = this._schemas.get( type )
    return versions ? [ ...versions.keys() ] : []
  }

  registeredTypes(): string[] {
    return [ ...this._schemas.keys() ]
  }
}

export const globalSchemaRegistry = new SchemaRegistry()

// ── Built-in schemas ─────────────────────────────────────────

function isRecord( v: unknown ): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray( v )
}

globalSchemaRegistry.register({
  type: 'clock.tick',
  version: 1,
  validate( payload ){
    if( !isRecord( payload ) ) return 'clock.tick payload must be an object'
    if( typeof payload['tick'] !== 'number' ) return 'clock.tick requires numeric tick'
    if( typeof payload['delta'] !== 'number' ) return 'clock.tick requires numeric delta'

    return null
  }
})
