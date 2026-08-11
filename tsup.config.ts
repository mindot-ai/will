import { defineConfig } from 'tsup'

export default defineConfig({
  entry:            [ 'src/index.ts', 'src/surface/cli.ts', 'src/surface/mcp/effectors.ts', 'src/surface/channels/discord.ts', 'src/surface/channels/whatsapp.ts' ],
  outDir:           'dist',
  format:           [ 'esm' ],
  target:           'esnext',
  dts:              true,            // emit .d.ts declaration files
  sourcemap:        true,
  clean:            true,            // wipe dist/ before each build
  splitting:        false,
  treeshake:        true,
  // optionalDependencies are NOT auto-externalized (only dependencies are) —
  // without this, discord.js and its WASM inline into dist/channels/discord.js
  // (and gitleaks false-positives on the base64). Same for the WhatsApp deps.
  external:         [ 'discord.js', 'baileys', 'pino', 'qrcode-terminal' ],
  // Resolve the will package's own #-aliases so dist has no bare-specifier imports
  // (mirrors the paths in tsconfig.json exactly)
  esbuildOptions( opts ){
    opts.alias = {
      '#core':        './src/core',
      '#cognition':   './src/cognition',
      '#faculties':   './src/cognition/faculties',
      '#agency':      './src/cognition/agency',
      '#senses':      './src/cognition/senses',
      '#memory':      './src/cognition/memory',
      '#surface':    './src/surface',
      '#llm':         './src/llm',
      '#pma':         './src/pma',
      '#types':       './src/types'
    }
  },
  // Runtime deps (package.json dependencies) are external by default — the MCP
  // SDK and zod resolve at runtime rather than being bundled.
})
