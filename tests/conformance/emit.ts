// ─────────────────────────────────────────────────────────────
// tests/conformance/emit.ts — serialize the pack for upstream
// ─────────────────────────────────────────────────────────────
//
//   bun tests/conformance/emit.ts            → prints the manifest
//   bun tests/conformance/emit.ts out.json   → writes it
//
// The scenarios are the half we contribute to HELM's conformance pack, and
// HELM's runner is Go — so they have to leave TypeScript. `scenarios.ts` is
// kept free of Will imports precisely so this stays a one-liner.
// ─────────────────────────────────────────────────────────────

import { writeFileSync } from 'node:fs'
import { SCENARIOS, packSummary } from './scenarios'

const manifest = {
  pack:     'denials-that-teach',
  rfc:      'HELM × Will v0.1',
  consumer: '@mindot/will',
  // Reported, not hidden: a pack that quietly under-tests is worse than one
  // that says where it stands.
  summary:  packSummary(),
  scenarios: SCENARIOS,
}

const json = JSON.stringify( manifest, null, 2 )
const out  = process.argv[2]

if( out ){
  writeFileSync( out, json + '\n')
  const { total, asserted, partial } = manifest.summary
  console.log(`✓ ${ out } — ${ total } scenarios (${ asserted } asserted, ${ partial } partial)`)
}
else console.log( json )
