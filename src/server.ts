import 'dotenv/config'
import { ZipArchive } from 'archiver'
import express from 'express'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { OpenCodeGoAdapter } from './llm/anthropic.js'
import { AgentRuntime } from './agent/runtime.js'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prompt = await readFile(path.join(directory, 'agent', 'prompt.md'), 'utf8')
const model = process.env.OPENCODE_MODEL || 'minimax-m3'
const apiKey = process.env.OPENCODE_API_KEY ?? ''
const port = Number(process.env.PORT ?? 3000)
const adapter = new OpenCodeGoAdapter(model, prompt, apiKey, Number(process.env.LLM_TIMEOUT_MS ?? 30000))
const runtime = new AgentRuntime(adapter, {
  directory,
  maxIterations: Number(process.env.MAX_ITERATIONS ?? 20),
  maxSessionTokens: Number(process.env.MAX_SESSION_TOKENS ?? 30000)
})
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '32kb' }))
app.use(express.static(path.join(directory, 'web')))

const requestSchema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), message: z.string().min(1).max(4000) })
const caseSchema = z.string().regex(/^[a-z0-9-]+$/)
const fileSchema = z.enum(['formulario.xlsx', 'formulario.pdf', 'valores-portal.md', 'checklist.md', 'borrador-correo.md', 'ENVIO-SIMULADO.md'])
const packagesRoot = path.join(directory, 'out')

type Artifact = { name: string; label: string; url: string }

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true).catch(() => false)
}

async function artifacts(caso: string): Promise<Artifact[]> {
  const candidates = [
    { name: 'formulario.xlsx', label: 'Formulario Excel', location: 'formulario.xlsx' },
    { name: 'formulario.pdf', label: 'Formulario PDF', location: 'formulario.pdf' },
    { name: 'valores-portal.md', label: 'Valores para portal', location: 'valores-portal.md' },
    { name: 'checklist.md', label: 'Checklist', location: path.join('paquete', 'checklist.md') },
    { name: 'borrador-correo.md', label: 'Borrador de correo', location: path.join('paquete', 'borrador-correo.md') },
    { name: 'ENVIO-SIMULADO.md', label: 'Envío simulado', location: 'ENVIO-SIMULADO.md' }
  ]
  const result: Artifact[] = []
  for (const candidate of candidates) {
    if (await exists(path.join(packagesRoot, caso, candidate.location))) result.push({ name: candidate.name, label: candidate.label, url: `/api/cases/${caso}/artifacts/${candidate.name}` })
  }
  if (await exists(path.join(packagesRoot, caso, 'paquete'))) result.push({ name: 'paquete.zip', label: 'Paquete completo ZIP', url: `/api/cases/${caso}/package.zip` })
  return result
}

app.get('/api/health', (_request, response) => response.json({ ok: true, provider: adapter.provider, model, configured: Boolean(apiKey) }))
app.get('/api/sessions/:id', (request, response) => response.json({ sessionId: request.params.id, history: runtime.history(request.params.id) }))
app.get('/api/cases/:caso/artifacts', async (request, response) => {
  const parsed = caseSchema.safeParse(request.params.caso)
  if (!parsed.success) return response.status(400).json({ error: 'Caso inválido.' })
  return response.json({ caso: parsed.data, artifacts: await artifacts(parsed.data) })
})
app.get('/api/cases/:caso/artifacts/:file', async (request, response) => {
  const parsedCase = caseSchema.safeParse(request.params.caso)
  const parsedFile = fileSchema.safeParse(request.params.file)
  if (!parsedCase.success || !parsedFile.success) return response.status(404).json({ error: 'Artefacto no encontrado.' })
  const packageFiles = new Set(['checklist.md', 'borrador-correo.md'])
  const file = packageFiles.has(parsedFile.data) ? path.join(packagesRoot, parsedCase.data, 'paquete', parsedFile.data) : path.join(packagesRoot, parsedCase.data, parsedFile.data)
  if (!await exists(file)) return response.status(404).json({ error: 'Artefacto no disponible.' })
  return response.download(file, parsedFile.data)
})
app.get('/api/cases/:caso/package.zip', async (request, response) => {
  const parsed = caseSchema.safeParse(request.params.caso)
  if (!parsed.success) return response.status(404).json({ error: 'Paquete no encontrado.' })
  const packageDirectory = path.join(packagesRoot, parsed.data, 'paquete')
  if (!await exists(packageDirectory)) return response.status(404).json({ error: 'Paquete no disponible.' })
  response.attachment(`paquete-${parsed.data}.zip`)
  response.type('application/zip')
  const archive = new ZipArchive({ zlib: { level: 9 } })
  archive.on('error', () => { if (!response.headersSent) response.status(500).end() })
  archive.pipe(response)
  archive.directory(packageDirectory, 'paquete')
  await archive.finalize()
})
app.post('/api/chat', async (request, response) => {
  const parsed = requestSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Solicitud inválida.' })
  const result = await runtime.chat(parsed.data.sessionId, parsed.data.message)
  return response.json(result)
})
app.use('/api', (_request, response) => response.status(404).json({ error: 'Ruta no encontrada.' }))

app.listen(port, () => console.log(`Agente disponible en http://localhost:${port}`))
