// ─────────────────────────────────────────────────────────────
// src/serve/server.ts — a Will, exposed over plain HTTP (the sidecar)
// ─────────────────────────────────────────────────────────────
//
// `will serve` for hosts that aren't Node and aren't MCP clients — a Python
// app, a game server, a cron job, anything that can speak HTTP. Same paradigm
// as the SDK facade and the MCP surface: a Will is a SUBJECT you speak to and
// observe, never a request/response function —
//
//   POST /perceive        deliver a stimulus  → 202 (delivered, not answered)
//   GET  /next-utterance  long-poll its next words; 200 {silence:true} is a
//                         real outcome, never an error
//   GET  /utterances      SSE stream of projections (utterance/emotion/action)
//   GET  /state           snapshot of its inner life
//   POST /save            checkpoint the living mind (non-destructive)
//   GET  /health          liveness: name, tick, uptime
//
// There is deliberately no ask()-shaped route. Zero dependencies (node:http).
// Boot/persistence/shutdown wiring lives in the CLI; this module only maps a
// facade instance onto a server (testable on an ephemeral port).
// ─────────────────────────────────────────────────────────────

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Will } from '#sdk/will'
import { UtteranceTap } from '#root/host/utterances'

export interface WillHttpOptions {
  /** Where POST /save writes the PMA artifact. */
  pmaPath?: string
}

const SSE_HEARTBEAT_MS = 15_000

function json( res: ServerResponse, status: number, body: unknown ): void {
  const text = JSON.stringify( body )
  res.writeHead( status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' } )
  res.end( text )
}

async function readJsonBody( req: IncomingMessage ): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await ( const c of req ) chunks.push( c as Buffer )
  const raw = Buffer.concat( chunks ).toString('utf8').trim()
  if( !raw ) return {}
  return JSON.parse( raw ) as Record<string, unknown>
}

/**
 * Map a running Will onto an HTTP server. The caller owns the Will's lifecycle
 * and calls `listen()`; everything here is the protocol surface.
 */
export function buildWillHttpServer( will: Will, opts: WillHttpOptions = {} ): Server {
  const tap   = new UtteranceTap( will )
  const born  = Date.now()

  // SSE subscribers — every projection fans out to all open streams.
  const streams = new Set<ServerResponse>()
  const fanout  = ( event: string, data: unknown ): void => {
    const frame = `event: ${ event }\ndata: ${ JSON.stringify( data ) }\n\n`
    for( const res of streams ) res.write( frame )
  }
  will.on('message',  m => fanout('utterance', m ) )
  will.on('emotion',  a => fanout('emotion', a ) )
  will.on('effector', a => fanout('action', a ) )

  const server = createServer( ( req, res ) => {
    void handle( req, res ).catch( err => {
      if( !res.headersSent )
        json( res, 500, { error: err instanceof Error ? err.message : String( err ) } )
      else res.end()
    } )
  } )

  async function handle( req: IncomingMessage, res: ServerResponse ): Promise<void> {
    const url = new URL( req.url ?? '/', 'http://sidecar')
    const route = `${ req.method } ${ url.pathname }`

    if( req.method === 'OPTIONS'){
      res.writeHead( 204, {
        'access-control-allow-origin':  '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      } )
      res.end()
      return
    }

    switch( route ){
      case 'GET /health':
        return json( res, 200, { ok: true, name: will.name, tick: will.state().tick, uptimeMs: Date.now() - born } )

      case 'GET /state':
        return json( res, 200, will.state() )

      case 'POST /perceive': {
        const body = await readJsonBody( req )
        const text = typeof body.text === 'string' ? body.text : ''
        if( !text ) return json( res, 400, { error: 'text is required' } )
        await will.perceive( {
          text,
          ...( typeof body.from    === 'string' ? { from:    body.from }    : {} ),
          ...( typeof body.speaker === 'string' ? { speaker: body.speaker } : {} ),
        } )
        // 202: delivered into the sensory field — NOT answered. A response, if
        // any, arrives on /utterances or /next-utterance; silence is valid.
        return json( res, 202, { delivered: true, tick: will.state().tick } )
      }

      case 'GET /next-utterance': {
        const within = Math.min( Math.max( parseInt( url.searchParams.get('within_ms') ?? '15000') || 15_000, 100 ), 120_000 )
        const from   = url.searchParams.get('from') ?? undefined
        const msg    = await tap.next( within, from )
        return msg
          ? json( res, 200, { utterance: msg } )
          : json( res, 200, { silence: true, waitedMs: within } )   // a choice, not an error
      }

      case 'GET /utterances': {
        res.writeHead( 200, {
          'content-type':                'text/event-stream',
          'cache-control':               'no-cache',
          'connection':                  'keep-alive',
          'access-control-allow-origin': '*',
        } )
        res.write(`event: hello\ndata: ${ JSON.stringify( { name: will.name, tick: will.state().tick } ) }\n\n`)
        streams.add( res )
        const heartbeat = setInterval( () => res.write(`: tick ${ will.state().tick }\n\n`), SSE_HEARTBEAT_MS )
        req.on('close', () => { clearInterval( heartbeat ); streams.delete( res ) } )
        return
      }

      case 'POST /save': {
        if( !opts.pmaPath ) return json( res, 409, { error: 'no PMA path configured — set WILL_PMA_PATH' } )
        const pma = await will.save()
        mkdirSync( dirname( opts.pmaPath ), { recursive: true } )
        writeFileSync( opts.pmaPath, JSON.stringify( pma ) )
        return json( res, 200, { saved: true, path: opts.pmaPath } )
      }

      default:
        return json( res, 404, {
          error: `no such route: ${ route }`,
          routes: [ 'GET /health', 'GET /state', 'POST /perceive', 'GET /next-utterance', 'GET /utterances (SSE)', 'POST /save' ],
        } )
    }
  }

  // Close open SSE streams when the server closes (so close() can complete).
  server.on('close', () => { for( const res of streams ) res.end(); streams.clear() } )

  return server
}
