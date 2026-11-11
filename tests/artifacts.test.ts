import test from 'node:test'
import assert from 'node:assert/strict'
import { access, cp, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, type CampoSolicitado, type Mapeo } from '../src/tools/proveedor.js'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function context() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'proveedor-artifacts-'))
  await cp(path.join(process.cwd(), 'fixtures'), path.join(directory, 'fixtures'), { recursive: true })
  return { directory, sessionId: 'test' }
}

test('prepara los artefactos descargables del paquete', async () => {
  const ctx = await context(), caso = 'co-industrias-delta'
  const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as Result<{ campos: CampoSolicitado[] }>
  assert.equal(request.ok, true); if (!request.ok) return
  const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as Result<Mapeo>
  assert.equal(mapping.ok, true); if (!mapping.ok) return
  await generar_formulario.execute({ caso, mapeo: mapping.data }, ctx)
  await armar_paquete.execute({ caso }, ctx)
  for (const file of ['formulario.xlsx', 'paquete/checklist.md', 'paquete/borrador-correo.md']) await access(path.join(ctx.directory, 'out', caso, file))
  assert.match(await readFile(path.join(ctx.directory, 'out', caso, 'paquete', 'checklist.md'), 'utf8'), /Cámara de Comercio|camara_comercio/)
})

test('la interfaz presenta los cuatro casos de fixture', async () => {
  const html = await readFile(path.join(process.cwd(), 'web', 'index.html'), 'utf8')
  for (const label of ['Colombia · Excel', 'Ecuador · PDF', 'Honduras · Excel', 'Panamá · Portal']) assert.match(html, new RegExp(label))
})
