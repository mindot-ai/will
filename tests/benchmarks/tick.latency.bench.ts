// tests/benchmarks/tick.latency.bench.ts
import { describe, bench, beforeAll } from 'vitest'
import { DefaultSimulation } from '#core/simulation'
import { EnergyRegulator } from '#faculties/energy.regulator'
import { SleepPressureRegulator } from '#faculties/sleep.pressure.regulator'
import { CircadianOscillator } from '#faculties/circadian.oscillator'
import { StressRegulator } from '#faculties/stress.regulator'
import { AttentionAllocator } from '#faculties/attention.allocator'
import { AffectiveBlender } from '#faculties/affective.blender'
import { GoalManager } from '#faculties/goal.manager'
import { NoveltyDetector } from '#faculties/novelty.detector'
import { WorkingMemory } from '#faculties/working.memory'
import { ThreatEvaluator } from '#faculties/threat.evaluator'
import { RewardEvaluator } from '#faculties/reward.evaluator'

function buildSimulation() {
  const sim = new DefaultSimulation({ randomSeed: 1, clock: { fixedDeltaMs: 50 } })
  sim.addEngine( new EnergyRegulator() )
  sim.addEngine( new SleepPressureRegulator() )
  sim.addEngine( new CircadianOscillator() )
  sim.addEngine( new StressRegulator() )
  sim.addEngine( new AttentionAllocator() )
  sim.addEngine( new AffectiveBlender() )
  sim.addEngine( new GoalManager() )
  sim.addEngine( new NoveltyDetector() )
  sim.addEngine( new WorkingMemory() )
  sim.addEngine( new ThreatEvaluator() )
  sim.addEngine( new RewardEvaluator() )
  return sim
}

describe('Tick latency benchmarks', () => {
  bench('single tick — 11 regulatory + affective engines (quiet state)', async () => {
    const sim = buildSimulation()
    await sim.step(1)
  })

  bench('100 ticks — 11 engines (stable drives)', async () => {
    const sim = buildSimulation()
    await sim.step(100)
  })
})
