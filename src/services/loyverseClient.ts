import type { PaginatedResponse } from '../types/loyverse.js'

export class LoyverseApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'LoyverseApiError'
  }
}

export interface LoyverseConfig {
  baseUrl: string
  token: string
}

export function getLoyverseConfig(): LoyverseConfig | null {
  const token = process.env.LOYVERSE_ACCESS_TOKEN?.trim()
  if (!token) return null

  const baseUrl = (process.env.LOYVERSE_API_BASE_URL ?? 'https://api.loyverse.com/v1.0').replace(
    /\/$/,
    '',
  )

  return { baseUrl, token }
}

export function isLoyverseConfigured(): boolean {
  return getLoyverseConfig() !== null
}

export async function loyverseFetch<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const config = getLoyverseConfig()
  if (!config) {
    throw new LoyverseApiError('LOYVERSE_ACCESS_TOKEN is not set', 503)
  }

  const url = new URL(`${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
  })

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    const errors = body.errors as Array<{ details?: string }> | undefined
    const message =
      errors?.[0]?.details ?? (body.message as string) ?? `Loyverse API error (${response.status})`
    throw new LoyverseApiError(message, response.status, body)
  }

  return body as T
}

export async function loyversePost<T>(path: string, body: unknown): Promise<T> {
  const config = getLoyverseConfig()
  if (!config) {
    throw new LoyverseApiError('LOYVERSE_ACCESS_TOKEN is not set', 503)
  }

  const url = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    const errors = parsed.errors as Array<{ details?: string }> | undefined
    const message =
      errors?.[0]?.details ??
      (parsed.message as string) ??
      `Loyverse API error (${response.status})`
    throw new LoyverseApiError(message, response.status, parsed)
  }

  return parsed as T
}

/** Paginate Loyverse list endpoints using cursor */
export async function fetchAllPages<TItem>(
  path: string,
  listKey: string,
  params: Record<string, string | number | undefined> = {},
  maxPages = 20,
): Promise<TItem[]> {
  const items: TItem[] = []
  let cursor: string | undefined

  let previousCursor: string | undefined

  for (let page = 0; page < maxPages; page++) {
    const response = await loyverseFetch<PaginatedResponse<TItem>>(path, {
      ...params,
      limit: params.limit ?? 250,
      cursor,
    })

    const batch = response[listKey]
    if (Array.isArray(batch)) {
      if (batch.length === 0) break
      items.push(...batch)
    }

    const nextCursor = typeof response.cursor === 'string' ? response.cursor : undefined
    if (!nextCursor || nextCursor === previousCursor) break
    previousCursor = nextCursor
    cursor = nextCursor
  }

  return items
}
