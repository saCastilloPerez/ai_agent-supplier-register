import type { NextFunction, Request, Response } from 'express'

type Entry = { count: number; resetAt: number }

export function createRateLimit(limit: number, windowMs: number) {
  const requests = new Map<string, Entry>()
  return (request: Request, response: Response, next: NextFunction): void => {
    const now = Date.now()
    const key = request.ip || 'unknown'
    const current = requests.get(key)
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current
    entry.count += 1
    requests.set(key, entry)
    if (entry.count > limit) {
      response.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
      response.status(429).json({ error: 'Demasiadas solicitudes. Intenta nuevamente más tarde.' })
      return
    }
    next()
  }
}
