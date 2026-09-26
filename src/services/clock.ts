import type { Db } from '../db'

export interface Clock {
  now(): Promise<Date>
}

export class SystemClock implements Clock {
  async now() {
    return new Date()
  }
}

export class FixedClock implements Clock {
  constructor(private at: Date) {}
  set(d: Date) {
    this.at = d
  }
  async now() {
    return new Date(this.at.getTime())
  }
}

/**
 * Reads an optional frozen timestamp from settings ("frozen_now"). Used by the demo/ops console
 * to time-travel through a subscription term deterministically. Falls back to the real clock.
 */
export class SettingsClock implements Clock {
  constructor(private db: Db) {}
  async now() {
    const row = await this.db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'frozen_now'`)
    if (row?.value) {
      const d = new Date(row.value)
      if (!Number.isNaN(d.getTime())) return d
    }
    return new Date()
  }
}
