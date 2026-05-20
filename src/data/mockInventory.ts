import { MOCK_AUDIT_RECORDS } from './mockAudit.js'

/** Latest stock per item from mock audit data */
export function getMockStockByItem(): Map<string, number> {
  const stocks = new Map<string, number>()
  for (const record of MOCK_AUDIT_RECORDS) {
    stocks.set(record.itemName, record.newStock)
  }
  return stocks
}
