import type { Db } from '../db'
import { MockPayoutProvider } from './mock-provider'
import { PayoutService } from './payout-service'
import { RecognitionService } from './recognition-service'
import { RefundService } from './refund-service'
import { SubscriptionService } from './subscription-service'
import { SettingsClock, type Clock } from './clock'

export interface Services {
  db: Db
  clock: Clock
  provider: MockPayoutProvider
  subscriptions: SubscriptionService
  recognition: RecognitionService
  refunds: RefundService
  payouts: PayoutService
}

export function buildServices(db: Db, clock: Clock = new SettingsClock(db), provider = new MockPayoutProvider(db)): Services {
  return {
    db,
    clock,
    provider,
    subscriptions: new SubscriptionService(db),
    recognition: new RecognitionService(db),
    refunds: new RefundService(db),
    payouts: new PayoutService(db, provider, clock)
  }
}
