import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import ExcelJS from 'exceljs'
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio, type CampoSolicitado, type Mapeo } from '../src/tools/proveedor.js'
import { AgentRuntime } from '../src/agent/runtime.js'
import type { LlmAdapter, LlmResponse, Message, ToolResultBlock } from '../src/llm/adapter.js'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }
async function context() { const directory = await mkdtemp(path.join(os.tmpdir(), 'proveedor-')); await cp(path.join(process.cwd(), 'fixtures'), path.join(directory, 'fixtures'), { recursive: true }); return { directory, sessionId: 'test' } }

test('mapea identificador extranjero y no inventa faltantes', async () => {
  const ctx = await context(), caso = 'ec-corp-andina'
  const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as Result<{ campos: CampoSolicitado[] }>
  assert.equal(request.ok, true); if (!request.ok) return
  const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as Result<Mapeo>
  assert.equal(mapping.ok, true); if (!mapping.ok) return
  assert.equal(mapping.data.requiere_confirmacion[0]?.etiqueta, 'RUC')
  assert.ok(mapping.data.faltantes.some((field) => field.etiqueta === 'Número de contribuyente especial'))
})

test('genera Excel en las celdas indicadas', async () => {
  const ctx = await context(), caso = 'co-industrias-delta'
  const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as Result<{ campos: CampoSolicitado[] }>; if (!request.ok) return
  const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as Result<Mapeo>; if (!mapping.ok) return
  const generated = JSON.parse(await generar_formulario.execute({ caso, mapeo: mapping.data }, ctx)) as Result<{ ruta: string }>; assert.equal(generated.ok, true); if (!generated.ok) return
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path.join(ctx.directory, generated.data.ruta))
  assert.equal(workbook.getWorksheet('Datos Proveedor')?.getCell('C3').value, 'Periferia IT Group S.A.S.')
  assert.equal(workbook.getWorksheet('Datos Bancarios')?.getCell('C5').value, '03100012345')
})

test('acepta mapeos equivalentes con campos y propiedades reordenados', async () => {
  const ctx = await context(), caso = 'ec-corp-andina'
  const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as Result<{ campos: CampoSolicitado[] }>
  assert.equal(request.ok, true); if (!request.ok) return
  const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as Result<Mapeo>
  assert.equal(mapping.ok, true); if (!mapping.ok) return
  const reorder = <T extends object>(items: T[]): T[] => [...items].reverse().map((item) => Object.fromEntries(Object.entries(item).reverse()) as T)
  const reordered: Mapeo = { requiere_confirmacion: reorder(mapping.data.requiere_confirmacion), faltantes: reorder(mapping.data.faltantes), llenos: reorder(mapping.data.llenos) }
  const generated = JSON.parse(await generar_formulario.execute({ caso, mapeo: reordered }, ctx)) as Result<{ ruta: string }>
  assert.equal(generated.ok, true)
  if (generated.ok) assert.ok((await readFile(path.join(ctx.directory, generated.data.ruta))).subarray(0, 5).equals(Buffer.from('%PDF-')))
})

test('rechaza mapeos alterados, incompletos o duplicados', async () => {
  const ctx = await context(), caso = 'co-industrias-delta'
  const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as Result<{ campos: CampoSolicitado[] }>
  assert.equal(request.ok, true); if (!request.ok) return
  const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as Result<Mapeo>
  assert.equal(mapping.ok, true); if (!mapping.ok) return
  const altered = structuredClone(mapping.data)
  altered.llenos[0].valor = 'Valor inventado'
  const missing = structuredClone(mapping.data)
  missing.llenos.pop()
  const duplicate = structuredClone(mapping.data)
  duplicate.llenos[1] = duplicate.llenos[0]
  for (const mapeo of [altered, missing, duplicate]) {
    const result = JSON.parse(await generar_formulario.execute({ caso, mapeo }, ctx)) as Result<{ ruta: string }>
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /no coincide/)
  }
  await assert.rejects(readFile(path.join(ctx.directory, 'out', caso, 'formulario.xlsx')))
})

test('el chat usa el mapeo verificado de su sesión aunque el modelo altere valores', async () => {
  const ctx = await context(), caso = 'co-industrias-delta'
  let step = 0
  const adapter: LlmAdapter = {
    provider: 'test', model: 'test',
    async enviar(messages: Message[]): Promise<LlmResponse> {
      const toolResult = messages.at(-1)?.content
      const result = Array.isArray(toolResult) ? toolResult[0] as ToolResultBlock : undefined
      const data = result ? (JSON.parse(result.content) as { data: unknown }).data : undefined
      let content: LlmResponse['content']
      if (step === 0) content = [{ type: 'tool_use', id: 'read', name: 'proveedor_leer_solicitud', input: { caso } }]
      else if (step === 1) content = [{ type: 'tool_use', id: 'map', name: 'proveedor_mapear_campos', input: { caso, campos: (data as { campos: CampoSolicitado[] }).campos } }]
      else if (step === 2) {
        const mapeo = structuredClone(data as Mapeo)
        mapeo.llenos[0].valor = 'Valor inventado'
        content = [{ type: 'tool_use', id: 'generate', name: 'proveedor_generar_formulario', input: { caso, mapeo } }]
      } else content = [{ type: 'text', text: 'Formulario generado.' }]
      step++
      return { content, inputTokens: 10, outputTokens: 10 }
    }
  }
  const runtime = new AgentRuntime(adapter, { directory: ctx.directory, maxIterations: 5, maxSessionTokens: 10000 })
  const response = await runtime.chat('sesion-test', 'Procesa el caso')
  const generated = response.toolCalls.find((call) => call.name === 'proveedor_generar_formulario')
  assert.equal((generated?.result as { ok: boolean }).ok, true)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path.join(ctx.directory, 'out', caso, 'formulario.xlsx'))
  assert.equal(workbook.getWorksheet('Datos Proveedor')?.getCell('C3').value, 'Periferia IT Group S.A.S.')
  const args = generated?.arguments as { mapeo: Mapeo }
  assert.equal(args.mapeo.llenos[0].valor, 'Periferia IT Group S.A.S.')
})

test('el chat usa los campos originales de la solicitud aunque el modelo omita uno', async () => {
  const ctx = await context(), caso = 'co-industrias-delta'
  let step = 0
  const adapter: LlmAdapter = {
    provider: 'test', model: 'test',
    async enviar(messages: Message[]): Promise<LlmResponse> {
      const toolResult = messages.at(-1)?.content
      const result = Array.isArray(toolResult) ? toolResult[0] as ToolResultBlock : undefined
      const data = result ? (JSON.parse(result.content) as { data: unknown }).data : undefined
      let content: LlmResponse['content']
      if (step === 0) content = [{ type: 'tool_use', id: 'read', name: 'proveedor_leer_solicitud', input: { caso } }]
      else if (step === 1) {
        const fields = structuredClone((data as { campos: CampoSolicitado[] }).campos)
        fields.pop()
        content = [{ type: 'tool_use', id: 'map', name: 'proveedor_mapear_campos', input: { caso, campos: fields } }]
      } else if (step === 2) content = [{ type: 'tool_use', id: 'generate', name: 'proveedor_generar_formulario', input: { caso, mapeo: data } }]
      else content = [{ type: 'text', text: 'Formulario generado.' }]
      step++
      return { content, inputTokens: 10, outputTokens: 10 }
    }
  }
  const runtime = new AgentRuntime(adapter, { directory: ctx.directory, maxIterations: 5, maxSessionTokens: 10000 })
  const response = await runtime.chat('sesion-test', 'Procesa el caso')
  const mapped = response.toolCalls.find((call) => call.name === 'proveedor_mapear_campos')
  const generated = response.toolCalls.find((call) => call.name === 'proveedor_generar_formulario')
  assert.equal((generated?.result as { ok: boolean }).ok, true)
  assert.equal((mapped?.arguments as { campos: CampoSolicitado[] }).campos.length, 17)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path.join(ctx.directory, 'out', caso, 'formulario.xlsx'))
  assert.equal(workbook.getWorksheet('Datos Bancarios')?.getCell('C6').value, 'Periferia IT Group S.A.S.')
})

test('calcula identidad y bloqueos de firma solo desde reglas deterministas', async () => {
  const expected = {
    'co-industrias-delta': ['soporte_vencido'],
    'ec-corp-andina': ['soporte_vencido', 'soporte_ausente'],
    'hn-agroexport-sula': ['soporte_vencido', 'soporte_vencido'],
    'pa-logistica-istmo': ['soporte_vencido', 'formato_no_soportado']
  }
  for (const [caso, bloqueos] of Object.entries(expected)) {
    const ctx = await context()
    const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as Result<{ campos: CampoSolicitado[] }>
    assert.equal(request.ok, true); if (!request.ok) continue
    const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as Result<Mapeo>
    assert.equal(mapping.ok, true); if (!mapping.ok) continue
    await generar_formulario.execute({ caso, mapeo: mapping.data }, ctx)
    const pack = JSON.parse(await armar_paquete.execute({ caso }, ctx)) as Result<{
      solicitante: { cliente: string; pais: string }
      proveedor_registrado: { razon_social: string; pais: string }
      listo_para_firma: boolean
      bloqueos_firma: Array<{ tipo: string }>
      campos_faltantes: unknown[]
    }>
    assert.equal(pack.ok, true); if (!pack.ok) continue
    assert.equal(pack.data.proveedor_registrado.razon_social, 'Periferia IT Group S.A.S.')
    assert.equal(pack.data.proveedor_registrado.pais, 'CO')
    assert.deepEqual(pack.data.bloqueos_firma.map((item) => item.tipo), bloqueos)
    assert.equal(pack.data.listo_para_firma, false)
    if (caso === 'hn-agroexport-sula') assert.equal(pack.data.campos_faltantes.length, 1)
  }
})

test('bloquea paquete por soporte ausente y envío sin confirmar', async () => {
  const ctx = await context(), caso = 'ec-corp-andina'
  const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as Result<{ campos: CampoSolicitado[] }>; if (!request.ok) return
  const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as Result<Mapeo>; if (!mapping.ok) return
  await generar_formulario.execute({ caso, mapeo: mapping.data }, ctx)
  const pack = JSON.parse(await armar_paquete.execute({ caso }, ctx)) as Result<{ listo_para_firma: boolean; checklist: { estado: string }[] }>
  assert.equal(pack.ok, true); if (!pack.ok) return
  assert.equal(pack.data.listo_para_firma, false); assert.ok(pack.data.checklist.some((item) => item.estado === 'ausente'))
  const send = JSON.parse(await simular_envio.execute({ caso, confirmado: false }, ctx)) as Result<{ ruta: string }>
  assert.equal(send.ok, false)
  await assert.rejects(readFile(path.join(ctx.directory, 'out', caso, 'ENVIO-SIMULADO.md')))
})
