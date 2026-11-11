import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimit } from '../src/rate-limit.js'

test('limita solicitudes por IP dentro de la ventana', () => {
  const middleware = createRateLimit(2, 60000)
  const statuses: number[] = []
  const request = { ip: '127.0.0.1' }
  const response = {
    set: () => response,
    status: (code: number) => { statuses.push(code); return response },
    json: () => response
  }
  let nextCalls = 0
  const next = () => { nextCalls++ }
  middleware(request as never, response as never, next)
  middleware(request as never, response as never, next)
  middleware(request as never, response as never, next)
  assert.equal(nextCalls, 2)
  assert.deepEqual(statuses, [429])
})
