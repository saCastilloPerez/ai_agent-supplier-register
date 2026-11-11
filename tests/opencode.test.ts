import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeGoAdapter } from '../src/llm/anthropic.js'

test('usa OpenCode Go con autorización Bearer y conserva llamadas a herramientas', async () => {
  let target = ''
  let authorization = ''
  let anthropicKey: string | null = null
  let session = ''
  let userAgent = ''
  let body: Record<string, unknown> = {}
  const mockFetch: typeof fetch = async (request, init) => {
    const sent = new Request(request, init)
    target = sent.url
    authorization = sent.headers.get('authorization') ?? ''
    anthropicKey = sent.headers.get('x-api-key')
    session = sent.headers.get('x-opencode-session') ?? ''
    userAgent = sent.headers.get('user-agent') ?? ''
    body = await sent.json() as Record<string, unknown>
    return Response.json({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'minimax-m3',
      content: [{ type: 'tool_use', id: 'tool_1', name: 'proveedor_leer_solicitud', input: { caso: 'ec-corp-andina' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 25, output_tokens: 12 }
    })
  }
  const adapter = new OpenCodeGoAdapter('minimax-m3', 'prompt', 'clave-de-prueba', 30000, mockFetch)
  const result = await adapter.enviar([{ role: 'user', content: 'Procesa el caso' }], [{ name: 'proveedor_leer_solicitud', description: 'Leer', inputSchema: { type: 'object', properties: {} } }], 500, 'sesion-prueba')
  assert.equal(target, 'https://opencode.ai/inference/go/anthropic/v1/messages')
  assert.equal(authorization, 'Bearer clave-de-prueba')
  assert.equal(anthropicKey, null)
  assert.equal(session, 'sesion-prueba')
  assert.equal(userAgent, 'registro-proveedor/1.0')
  assert.equal(body.model, 'minimax-m3')
  assert.deepEqual(result.content, [{ type: 'tool_use', id: 'tool_1', name: 'proveedor_leer_solicitud', input: { caso: 'ec-corp-andina' } }])
  assert.equal(result.inputTokens, 25)
})
