// ─────────────────────────────────────────────────────────────
// src/core/abstracts.ts
// ─────────────────────────────────────────────────────────────

/**
 * Independent abstractions that decouple the framework from
 * runtime-specific implementations.  New cross-cutting abstractions
 * belong here alongside existing ones.
 */

// ── Storage ─────────────────────────────────────────────────

export interface StorageAdapter {
  write( path: string, content: string | Uint8Array ): Promise<void>
  read( path: string ): Promise<string>
  readBytes( path: string ): Promise<Uint8Array>
  exists( path: string ): Promise<boolean>
  delete?( path: string ): Promise<void>
  ensureDir?( path: string ): Promise<void>
}

/**
 * Bun-native storage adapter, with a node:fs fallback when the Bun global is
 * absent — the engine is Node-compatible (Bun remains the primary target).
 * Default for all framework components that perform file I/O.
 */
export class BunStorageAdapter implements StorageAdapter {
  private get _isBun(): boolean { return typeof Bun !== 'undefined' }

  async write( path: string, content: string | Uint8Array ): Promise<void> {
    if( this._isBun ){
      await Bun.write( path, content )
      return
    }
    // Bun.write creates parent directories; node's writeFile does not.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname }          = await import('node:path')
    await mkdir( dirname( path ), { recursive: true } )
    await writeFile( path, content )
  }

  async read( path: string ): Promise<string> {
    if( !( await this.exists( path ) ) )
      throw new Error(`File not found: ${path}`)

    if( this._isBun )
      return Bun.file( path ).text()

    const { readFile } = await import('node:fs/promises')
    return readFile( path, 'utf8' )
  }

  async readBytes( path: string ): Promise<Uint8Array> {
    if( !( await this.exists( path ) ) )
      throw new Error(`File not found: ${path}`)

    if( this._isBun )
      return new Uint8Array( await Bun.file( path ).arrayBuffer() )

    const { readFile } = await import('node:fs/promises')
    return new Uint8Array( await readFile( path ) )
  }

  async exists( path: string ): Promise<boolean> {
    if( this._isBun )
      return Bun.file( path ).exists()

    const { access } = await import('node:fs/promises')
    try { await access( path ); return true }
    catch { return false }
  }

  async delete( path: string ): Promise<void> {
    if( this._isBun ){
      const file = Bun.file( path )
      await file.exists() && await file.delete()
      return
    }
    const { rm } = await import('node:fs/promises')
    await rm( path, { force: true } )
  }

  async ensureDir( path: string ): Promise<void> {
    const { mkdirSync } = await import('node:fs')
    mkdirSync( path, { recursive: true } )
  }
}