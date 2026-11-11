import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentRuntime } from '../src/agent/runtime.js'
import type { LlmAdapter, LlmResponse, Message } from '../src/llm/adapter.js'

const caso = 'ec-corp-andina'

async function context() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'proveedor-confirmacion-'))
  await cp(path.join(process.cwd(), 'fixtures'), path.join(directory, 'fixtures'), { recursive: true })
  return directory
}

function adapter(): LlmAdapter {
  return {
    provider: 'test', model: 'test',
    async enviar(messages: Message[]): Promise<LlmResponse> {
      const last = messages.at(-1)
      const content: LlmResponse['content'] = typeof last?.content === 'string' && last.content === 'Preparar'
        ? [{ type: 'tool_use', id: 'package', name: 'proveedor_armar_paquete', input: { caso } }]
        : [{ type: 'text', text: 'Resultado disponible.' }]
      return { content, inputTokens: 10, outputTokens: 10 }
    }
  }
}

async function runtime() {
  const directory = await context()
  return { directory, agent: new AgentRuntime(adapter(), { directory, maxIterations: 5, maxSessionTokens: 10000 }) }
}

const output = (directory: string) => path.join(directory, 'out', caso, 'ENVIO-SIMULADO.md')

test('pregunta después del paquete y solo simula al confirmar en el siguiente turno', async () => {
  const { directory, agent } = await runtime()
  const first = await agent.chat('sesion', 'Preparar')
  assert.equal(first.needsConfirmation, true)
  assert.match(first.reply, /¿Confirmas simular el envío del caso ec-corp-andina\?/)
  await assert.rejects(readFile(output(directory)))
  const second = await agent.chat('sesion', 'Sí')
  assert.equal(second.needsConfirmation, false)
  assert.equal(second.toolCalls[0]?.name, 'proveedor_simular_envio')
  assert.match(await readFile(output(directory), 'utf8'), /No se realizó ninguna acción externa/)
  const third = await agent.chat('sesion', 'Sí')
  assert.equal(third.toolCalls.some((call) => call.name === 'proveedor_simular_envio'), false)
})

test('el cierre del servidor distingue solicitante, proveedor y bloqueos', async () => {
  const { agent } = await runtime()
  const response = await agent.chat('sesion', 'Preparar')
  assert.match(response.reply, /Solicitante: Corporación Andina de Servicios S.A. \(EC\)\./)
  assert.match(response.reply, /Proveedor registrado: Periferia IT Group S.A.S. \(CO\)\./)
  assert.match(response.reply, /soporte vencido \(camara_comercio\)/)
  assert.match(response.reply, /soporte ausente \(certificado_cumplimiento_tributario\)/)
  assert.doesNotMatch(response.reply, /campos faltantes.*bloque/i)
})

test('rechazar cancela la confirmación sin simular ni llamar al modelo', async () => {
  const { directory, agent } = await runtime()
  await agent.chat('sesion', 'Preparar')
  const response = await agent.chat('sesion', 'No')
  assert.equal(response.needsConfirmation, false)
  assert.match(response.reply, /cancelada/)
  await assert.rejects(readFile(output(directory)))
  const later = await agent.chat('sesion', 'Sí')
  assert.equal(later.toolCalls.some((call) => call.name === 'proveedor_simular_envio'), false)
})

test('cambio de tema y respuesta ambigua anulan la confirmación pendiente', async () => {
  for (const answer of ['¿Qué soportes faltan?', 'Sí, pero espera']) {
    const { directory, agent } = await runtime()
    await agent.chat('sesion', 'Preparar')
    const response = await agent.chat('sesion', answer)
    assert.equal(response.needsConfirmation, false)
    const later = await agent.chat('sesion', 'Sí')
    assert.equal(later.toolCalls.some((call) => call.name === 'proveedor_simular_envio'), false)
    await assert.rejects(readFile(output(directory)))
  }
})

test('la confirmación no se comparte con otra sesión', async () => {
  const { directory, agent } = await runtime()
  await agent.chat('sesion-a', 'Preparar')
  const other = await agent.chat('sesion-b', 'Sí')
  assert.equal(other.toolCalls.some((call) => call.name === 'proveedor_simular_envio'), false)
  await assert.rejects(readFile(output(directory)))
  const own = await agent.chat('sesion-a', 'Sí')
  assert.equal(own.toolCalls[0]?.name, 'proveedor_simular_envio')
})

test('un paquete fallido no solicita confirmación', async () => {
  const directory = await context()
  const broken: LlmAdapter = {
    provider: 'test', model: 'test',
    async enviar(messages): Promise<LlmResponse> {
      const content: LlmResponse['content'] = typeof messages.at(-1)?.content === 'string'
        ? [{ type: 'tool_use', id: 'package', name: 'proveedor_armar_paquete', input: { caso: 'caso-inexistente' } }]
        : [{ type: 'text', text: 'No se pudo preparar el paquete.' }]
      return { content, inputTokens: 10, outputTokens: 10 }
    }
  }
  const agent = new AgentRuntime(broken, { directory, maxIterations: 5, maxSessionTokens: 10000 })
  const response = await agent.chat('sesion', 'Preparar')
  assert.equal(response.needsConfirmation, false)
})
