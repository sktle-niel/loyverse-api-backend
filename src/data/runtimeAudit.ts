import type { AuditRecord } from '../types/audit.js'

/** In-memory audit rows from API stock edits (merged into GET /api/audit). */
const runtimeAudit: AuditRecord[] = []

export function appendRuntimeAudit(records: AuditRecord[]): void {
  runtimeAudit.unshift(...records)
  if (runtimeAudit.length > 500) {
    runtimeAudit.length = 500
  }
}

export function getRuntimeAudit(): AuditRecord[] {
  return [...runtimeAudit]
}
