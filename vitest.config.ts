import { defineConfig } from 'vitest/config'
import path            from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '#cognition':  path.resolve( __dirname, 'src/cognition'  ),
      '#faculties':  path.resolve( __dirname, 'src/cognition/faculties' ),
      '#agency':     path.resolve( __dirname, 'src/cognition/agency' ),
      '#senses':     path.resolve( __dirname, 'src/cognition/senses' ),
      '#memory':     path.resolve( __dirname, 'src/cognition/memory' ),
      '#extensions': path.resolve( __dirname, 'src/extensions'        ),
      '#effectors':  path.resolve( __dirname, 'src/effectors'         ),
      '#sandboxes':  path.resolve( __dirname, 'src/sandboxes'         ),
      '#channels':   path.resolve( __dirname, 'src/channels'          ),
      '#profiles':   path.resolve( __dirname, 'src/profiles'          ),
      '#runners':    path.resolve( __dirname, 'src/runners'           ),
      '#core':       path.resolve( __dirname, 'src/core'              ),
      '#llm':        path.resolve( __dirname, 'src/llm'               ),
      '#types':      path.resolve( __dirname, 'src/types'             ),
      '#root':       path.resolve( __dirname, 'src'                   ),
      '#stem':       path.resolve( __dirname, 'src/stem'              ),
      '#pma':        path.resolve( __dirname, 'src/pma'               ),
      '#sdk':        path.resolve( __dirname, 'src/sdk'               ),
    },
  },
  test: {
    globals:     true,
    environment: 'node',
    include:     [ 'src/tests/**/*.test.ts', 'tests/**/*.test.ts' ],
    benchmark:   { include: [ 'tests/**/*.bench.ts' ] },
    exclude:     [ 'node_modules' ],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    reporters:   [ 'verbose' ],
    // Test files run in parallel (vitest 4 default). Safe after R4: runtime
    // state is per-Will/per-instance (no process-global token tracker or
    // WillStem), and each file is process-isolated with sequential in-file
    // tests. NB: the prior `singleFork: true` was a vitest 2/3 `poolOptions`
    // key — a no-op under vitest 4, whose lever is `fileParallelism`.
    fileParallelism: true,
  },
})
