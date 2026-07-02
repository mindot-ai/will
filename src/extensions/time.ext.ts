// ─────────────────────────────────────────────────────────────
// src/extensions/time.ext.ts
// ─────────────────────────────────────────────────────────────

/**
 * Time extension for logistics, mobility, IoT, and smart home scenarios.
 * These are NOT part of core — they layer on top.
 */

import type { SimulationClock } from '#core/clock'
import type { Timestamp } from '#core/types'

// ── Time-of-day utilities ─────────────────────────────────

export interface TimeOfDay {
  hour: number
  minute: number
  second: number
  millisecond: number
}

export interface DateComponents {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
  dayOfWeek: number  // 0 = Sunday, 6 = Saturday
  timestamp: Timestamp
}

export interface TimeWindow {
  startHour: number      // 0-23
  endHour: number        // 0-23, can wrap (e.g., 22-6 for overnight)
  startMinute?: number   // 0-59
  endMinute?: number     // 0-59
}

export class TimeExtension {
  private _clock: SimulationClock
  private _timezoneOffset: number  // minutes from UTC, e.g., -480 for PST
  // private _referenceDate: Date

  constructor( clock: SimulationClock, timezoneOffsetMinutes: number = 0 ){
    this._clock = clock
    this._timezoneOffset = timezoneOffsetMinutes
    // this._referenceDate = new Date( this._clock.now )
  }

  // ── Time-of-day (no date) ───────────────────────────────

  getTimeOfDay(): TimeOfDay {
    const date = this._getDateWithOffset()
    
    return {
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      millisecond: date.getMilliseconds()
    }
  }

  getHour(): number {
    return this._getDateWithOffset().getHours()
  }

  getMinute(): number {
    return this._getDateWithOffset().getMinutes()
  }

  isBetweenHours( startHour: number, endHour: number ): boolean {
    const hour = this.getHour()
    
    // Handle overnight windows (e.g., 22-6)
    if( startHour > endHour )
      return hour >= startHour || hour <= endHour
    
    return hour >= startHour && hour <= endHour
  }

  isWithinTimeWindow( window: TimeWindow ): boolean {
    const
    hour = this.getHour(),
    minute = this.getMinute(),

    currentMinutes = hour * 60 + minute,
    startMinutes = ( window.startHour * 60 ) + ( window.startMinute ?? 0 ),
    endMinutes = ( window.endHour * 60 ) + ( window.endMinute ?? 0 )
    
    // Handle overnight windows
    if( startMinutes > endMinutes )
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes
    
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes
  }

  // ── Full date/time (for scheduling) ─────────────────────

  getCurrentDateComponents(): DateComponents {
    const date = this._getDateWithOffset()
    
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      millisecond: date.getMilliseconds(),
      dayOfWeek: date.getDay(),
      timestamp: this._clock.now
    }
  }

  // ── Business hours / shift detection ────────────────────

  isBusinessHours( 
    businessStartHour: number = 9, 
    businessEndHour: number = 17,
    includeWeekends: boolean = false
  ): boolean {
    const
    components = this.getCurrentDateComponents(),
    isWeekend = components.dayOfWeek === 0 || components.dayOfWeek === 6
    
    if( !includeWeekends && isWeekend ) return false
    
    return this.isBetweenHours( businessStartHour, businessEndHour )
  }

  isRushHour( cityType: 'urban' | 'suburban' | 'rural' = 'urban'): boolean {
    const hour = this.getHour()
    
    switch( cityType ) {
      case 'urban':
        // Morning: 7-9, Evening: 16-19
        return ( hour >= 7 && hour <= 9 ) || ( hour >= 16 && hour <= 19 )
      
      case 'suburban':
        // Morning: 6-8, Evening: 17-19
        return ( hour >= 6 && hour <= 8 ) || ( hour >= 17 && hour <= 19 )
      
      case 'rural':
        // Minimal rush hour
        return ( hour >= 7 && hour <= 8 ) || ( hour >= 17 && hour <= 18 )
      
      default: return false
    }
  }

  // ── Day part detection (for smart home) ─────────────────

  getDayPart(): 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night' | 'late-night' {
    const hour = this.getHour()
    
    if( hour >= 5 && hour < 7 ) return 'dawn'
    if( hour >= 7 && hour < 12 ) return 'morning'
    if( hour >= 12 && hour < 17 ) return 'afternoon'
    if( hour >= 17 && hour < 21 ) return 'evening'
    if( hour >= 21 && hour < 24 ) return 'night'
    return 'late-night'
  }

  // ── ETA with time-of-day adjustment (logistics) ─────────

  calculateAdjustedEta( 
    baseMinutes: number, 
    trafficMultiplier: number = 1.0
  ): number {
    let multiplier = trafficMultiplier
    
    // Apply rush hour penalty
    if( this.isRushHour() ) multiplier *= 1.5
    
    // Apply night time bonus (less traffic)
    const hour = this.getHour()
    if( hour >= 22 || hour <= 5 ) multiplier *= 0.8
    
    return baseMinutes * multiplier
  }

  // ── Scheduling helpers ──────────────────────────────────

  getMinutesUntil( targetHour: number, targetMinute: number = 0 ): number {
    const
    current = this.getTimeOfDay(),
    currentMinutes = current.hour * 60 + current.minute,
    targetMinutes = targetHour * 60 + targetMinute
    
    if( targetMinutes > currentMinutes )
      return targetMinutes - currentMinutes
    
    // Target is tomorrow
    return ( 24 * 60 - currentMinutes ) + targetMinutes
  }

  getNextOccurrence( 
    targetHour: number, 
    targetMinute: number = 0,
    onlyFuture: boolean = true
  ): { minutesFromNow: number; timestamp: Timestamp } {
    const
    current = this.getTimeOfDay(),
    currentMinutes = current.hour * 60 + current.minute,
    targetMinutes = targetHour * 60 + targetMinute,
    msPerMinute = 60 * 1000
    
    let minutesDelta: number
    if( targetMinutes > currentMinutes )
      minutesDelta = targetMinutes - currentMinutes
    
    else if( onlyFuture )
      minutesDelta = ( 24 * 60 - currentMinutes ) + targetMinutes

    else minutesDelta = targetMinutes - currentMinutes
    
    const wallDeltaMs = this._clock.toWallMs( minutesDelta * 60 * 1000 )
    
    return {
      minutesFromNow: minutesDelta,
      timestamp: Date.now() + wallDeltaMs
    }
  }

  // ── Private helpers ─────────────────────────────────────

  private _getDateWithOffset(): Date {
    const
    simTime = this._clock.now,
    offsetMs = this._timezoneOffset * 60 * 1000

    return new Date( simTime + offsetMs )
  }

  // ── Convenience factory ─────────────────────────────────

  static forTimezone( clock: SimulationClock, timezone: string ): TimeExtension {
    // NOTE: Full IANA timezone support requires a library like 'luxon'
    // For now, uses local system timezone
    const offsetMinutes = -new Date().getTimezoneOffset()
    // In production, use Intl.DateTimeFormat or a library like 'luxon' for IANA conversion
    return new TimeExtension( clock, offsetMinutes )
  }
}

// ── Scenario helpers for time-based tests ─────────────────

export interface TimeScenarioConfig {
  startHour?: number
  startMinute?: number
  timeMultiplier?: number
  timezone?: string
}

export class TimeScenarioHelper {
  private _clock: SimulationClock
  private _extension: TimeExtension

  constructor( clock: SimulationClock, config: TimeScenarioConfig = {} ){
    this._clock = clock
    
    // Set initial time if specified
    if( config.startHour !== undefined ) {
      const startDate = new Date( this._clock.now )

      startDate.setHours( config.startHour, config.startMinute ?? 0, 0, 0 )
      this._clock.setTime( startDate.getTime() )
    }
    
    if( config.timeMultiplier )
      this._clock.setMultiplier( config.timeMultiplier )
    
    this._extension = config.timezone 
                        ? TimeExtension.forTimezone( this._clock, config.timezone )
                        : new TimeExtension( this._clock, -new Date().getTimezoneOffset() )
  }

  get clock(): SimulationClock { return this._clock }
  get time(): TimeExtension { return this._extension }

  // Fast-forward simulation to a specific time of day
  async advanceToTimeOfDay( 
    targetHour: number, 
    targetMinute: number = 0,
    maxWaitMs: number = 30000  // 30 seconds real-time max
  ): Promise<void> {
    const
    { minutesFromNow } = this._extension.getNextOccurrence( targetHour, targetMinute ),
    waitWallMs = this._clock.toWallMs( minutesFromNow * 60 * 1000 )
    
    if( waitWallMs > maxWaitMs )
      throw new Error(`Target time would require waiting ${waitWallMs}ms, exceeds max ${maxWaitMs}ms`)
    
    await this._clock.simSleep( minutesFromNow * 60 * 1000 )
  }
}

// Usage Examples
// Logistics: Time-of-day for delivery windows
// typescript
// import { DefaultSimulationClock } from './core/clock'
// import { TimeExtension } from './extension/time.ext'

// const clock = new DefaultSimulationClock({ timeScale: 60 }) // 1 real sec = 1 sim minute
// clock.startTicks()

// const timeExt = new TimeExtension( clock, -480 ) // PST

// // Check if within delivery window
// const isWithinWindow = timeExt.isWithinTimeWindow({
//   startHour: 9,
//   endHour: 17,
//   startMinute: 0,
//   endMinute: 0
// })

// // Adjust ETA for rush hour
// const baseEta = 30 // minutes
// const adjustedEta = timeExt.calculateAdjustedEta( baseEta, 1.2 )
// Smart Home: Day part detection
// typescript
// const dayPart = timeExt.getDayPart()

// switch( dayPart ) {
//   case 'dawn':
//     // Gradually increase lights
//     break
//   case 'night':
//     // Arm security system, turn off non-essential devices
//     break
// }
// Mobility: Rush hour detection
// typescript
// if( timeExt.isRushHour('urban') ) {
//   // Reroute to avoid congested areas
//   // Increase surge pricing
// }
