import { defineConfig } from 'tsup'

export default defineConfig({
  entry:            [ 'src/index.ts' ],
  outDir:           'dist',
  format:           [ 'esm' ],
  target:           'esnext',
  dts:              true,            // emit .d.ts declaration files
  sourcemap:        true,
  clean:            true,            // wipe dist/ before each build
  splitting:        false,
  treeshake:        true,
  // Resolve the will package's own #-aliases so dist has no bare-specifier imports
  // (mirrors the paths in tsconfig.json exactly)
  esbuildOptions( opts ){
    opts.alias = {
      '#core':        './src/core',
      '#deployment':  './src/deployment',
      '#effectors':   './src/effectors',
      '#cognition':   './src/cognition',
      '#faculties':   './src/cognition/faculties',
      '#agency':      './src/cognition/agency',
      '#senses':      './src/cognition/senses',
      '#memory':      './src/cognition/memory',
      '#channels':    './src/channels',
      '#profiles':    './src/profiles',
      '#runners':     './src/runners',
      '#llm':         './src/llm',
      '#pma':         './src/pma',
      '#extensions':  './src/extensions',
      '#sandboxes':   './src/sandboxes',
      '#types':       './src/types',
      '#root':        './src',
    }
  },
  // Runtime deps stay external — they resolve at runtime. Only list deps that
  // src actually imports (the LLM and vector layers are in-house, no SDKs).
  external: [
    '@aws-sdk/client-s3',
  ],
})
