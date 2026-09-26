/**
 * Provider contract (§8.1). The external provider is treated as an unreliable distributed system.
 */
import type { ProviderCreateOutcome, ProviderStatusOutcome } from './payout-state'

export interface PayoutProvider {
  createPayout(idempotencyKey: string, providerAccountId: string, amountMinor: number, currency: string): Promise<ProviderCreateOutcome>
  getPayoutStatus(idempotencyKey: string): Promise<ProviderStatusOutcome>
}

export const PROVIDER_SCENARIOS = [
  'SUCCESS',
  'PERMANENT_FAILURE',
  'TIMEOUT_AFTER_SUCCESS',
  'TIMEOUT_NO_EFFECT',
  'STATUS_UNKNOWN'
] as const
export type ProviderScenario = (typeof PROVIDER_SCENARIOS)[number]

export function isProviderScenario(v: string): v is ProviderScenario {
  return (PROVIDER_SCENARIOS as readonly string[]).includes(v)
}
