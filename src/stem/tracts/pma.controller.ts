// ─────────────────────────────────────────────────────────────
// src/stem/tracts/pma.controller.ts  —  per-Will PMA (portable mind archive)
// ─────────────────────────────────────────────────────────────
//
// PMAController owns the PMA subsystem extracted from WillStem (R5-b):
// the distiller (state → portable snapshot), the loader (snapshot →
// seeded Will), and the reconstruction-fidelity eval harness. WillStem
// delegates its loadPMA/distillPMA/runPMAEval methods here, resolving the
// WillInstance (and validating existence) before each call.
//
// Behaviour is preserved verbatim from the original WillStem methods;
// this is a pure extract-collaborator refactor.
// ─────────────────────────────────────────────────────────────

import { PMADistiller, PMALoader, type PMASnapshot } from '../../pma'
import { PMAEvalHarness, type ReconstructionFidelityReport } from '../../pma/eval'
import { validateWillIdentity } from '../guards/identity.guard'
import { logger } from '#core/logger'
import type { WillInstance } from '#stem/index'

export class PMAController {
  private readonly _distiller   = new PMADistiller()
  private readonly _loader      = new PMALoader()
  private readonly _evalHarness = new PMAEvalHarness()

  /**
   * Load a PMASnapshot into a paused or freshly-created Will. The Will must
   * not be active (status 'paused' or 'initializing'); seeding an active Will
   * with existing beliefs may cause unintended merges.
   */
  load( id: string, instance: WillInstance, pma: PMASnapshot ): void {
    if( instance.status === 'active' )
      throw new Error(`Cannot load PMA into an active Will (${id}). Pause first.`)

    // Re-validate the artifact's persona at the load boundary (Phase 2): a stored
    // or tampered PMA must not inject a collapsed / colliding / injected self on
    // reload, the same way creation guards the operator-supplied identity.
    const guard = validateWillIdentity({ identity: {
      prompt: pma.identity.prompt,
      values: pma.identity.values,
      traits: pma.identity.traits,
      style:  pma.identity.style,
    } })
    if( !guard.ok )
      throw new Error(`Invalid PMA identity for "${id}": ${ guard.errors.join('; ') }`)
    for( const w of guard.warnings )
      logger.warn(`[identity-guard] PMA ${id}: ${w}`)

    const safePma: PMASnapshot = { ...pma, identity: { ...pma.identity, ...guard.sanitized.identity } }

    this._loader.load(
      safePma,
      instance.simulation,
      instance.cognition,
    )
  }

  /**
   * Distill the current state of a Will into a portable PMASnapshot. Reads
   * simulation state and JSONL profile logs. Does NOT pause or modify the
   * Will — safe to call while active.
   */
  distill( id: string, instance: WillInstance ): PMASnapshot {
    const
    state     = instance.simulation.stateManager.snapshot(),
    sessionId = instance.sessionLogger?.sessionId ?? 'unknown',
    dataDir   = process.env[ 'WILL_DATA_DIR' ] ?? './data'

    return this._distiller.distill(
      id,
      instance.config.name ?? id,
      state,
      sessionId,
      dataDir,
      instance.cognition.schemaRepertoire,
    )
  }

  /**
   * Distill the Will and score how faithfully the PMA reconstructs it.
   * `vsOriginal` (with `behavioral`) captures the original's probe baseline
   * before evaluating, for reconstruction-vs-original behavioral fidelity.
   *
   * ⚠️ Not read-only when `behavioral` is set: the probe phase runs probes against
   * the LIVE Will, perturbing its state. Don't call it on a production Will you
   * need pristine — distil + eval a paused clone instead.
   */
  async runEval(
    id:       string,
    instance: WillInstance,
    opts:     { behavioral?: boolean; vsOriginal?: boolean } = {}
  ): Promise<ReconstructionFidelityReport> {
    // Distil the CLEAN state first — capturing the baseline below probes (and
    // therefore mutates) the live original, so order matters.
    const pma = this.distill( id, instance )

    let baselineDist: Record<string, Record<string, number>> | undefined
    if( opts.behavioral && opts.vsOriginal )
      baselineDist = await this._evalHarness.captureProbeBaseline(
        instance.simulation,
        instance.cognition,
      )

    return this._evalHarness.evaluate( pma, instance.config, {
      runBehavioralProbes: opts.behavioral ?? false,
      baselineDist,
    })
  }
}
