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
 * Bun-native storage adapter.
 * Default for all framework components that perform file I/O.
 */
export class BunStorageAdapter implements StorageAdapter {
  async write( path: string, content: string | Uint8Array ): Promise<void> {
    await Bun.write( path, content )
  }

  async read( path: string ): Promise<string> {
    const file = Bun.file( path )
    if( !( await file.exists() ) )
      throw new Error(`File not found: ${path}`)

    return file.text()
  }

  async readBytes( path: string ): Promise<Uint8Array> {
    const file = Bun.file( path )
    if( !( await file.exists() ) )
      throw new Error(`File not found: ${path}`)

    return new Uint8Array( await file.arrayBuffer() )
  }

  async exists( path: string ): Promise<boolean> {
    return Bun.file( path ).exists()
  }

  async delete( path: string ): Promise<void> {
    const file = Bun.file( path )
    await file.exists() && await file.delete()
  }
  
  async ensureDir( path: string ): Promise<void> {
    const { mkdirSync } = await import('node:fs')
    mkdirSync( path, { recursive: true } )
  }
}