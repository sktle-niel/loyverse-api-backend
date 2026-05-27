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

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
  delay = 1000,
): Promise<Response> {
  const timeoutMs = 12000 // 12 seconds timeout per attempt
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })

    // If rate limited (429), wait and retry
    if (response.status === 429 && retries > 0) {
      const retryAfterHeader = response.headers.get('Retry-After')
      let retryDelay = delay
      if (retryAfterHeader) {
        const seconds = parseInt(retryAfterHeader, 10)
        if (!isNaN(seconds)) {
          retryDelay = seconds * 1000
        }
      }
      console.warn(`[Loyverse Client] Rate limited (429). Retrying in ${retryDelay}ms... (${retries} retries left)`)
      await new Promise((resolve) => setTimeout(resolve, retryDelay))
      return fetchWithRetry(url, options, retries - 1, delay * 2)
    }

    // If server error (5xx), wait and retry
    if (response.status >= 500 && retries > 0) {
      console.warn(`[Loyverse Client] Server error (${response.status}). Retrying in ${delay}ms... (${retries} retries left)`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      return fetchWithRetry(url, options, retries - 1, delay * 2)
    }

    return response
  } catch (error: any) {
    const isAbort = error.name === 'AbortError'
    const errorMsg = isAbort ? 'Request timed out (12s)' : (error.message ?? String(error))
    
    if (retries > 0) {
      console.warn(`[Loyverse Client] Fetch failed: ${errorMsg}. Retrying in ${delay}ms... (${retries} retries left)`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      return fetchWithRetry(url, options, retries - 1, delay * 2)
    }
    throw new Error(`Loyverse connection failed: ${errorMsg}`)
  } finally {
    clearTimeout(timeoutId)
  }
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

  let response: Response
  try {
    response = await fetchWithRetry(url.toString(), {
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
    }, 3)
  } catch (err: any) {
    throw new LoyverseApiError(
      err.message ?? 'Failed to connect to Loyverse API',
      504,
    )
  }

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

  let response: Response
  try {
    response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 2) // Fewer retries for POST requests to avoid duplicate operations if safe
  } catch (err: any) {
    throw new LoyverseApiError(
      err.message ?? 'Failed to connect to Loyverse API',
      504,
    )
  }

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
