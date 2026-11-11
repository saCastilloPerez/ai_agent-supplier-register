import 'dotenv/config'
import express from 'express'
import { readFile } from 'node:fs/promises'
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

app.get('/api/health', (_request, response) => response.json({ ok: true, provider: adapter.provider, model, configured: Boolean(apiKey) }))
app.get('/api/sessions/:id', (request, response) => response.json({ sessionId: request.params.id, history: runtime.history(request.params.id) }))
app.post('/api/chat', async (request, response) => {
  const parsed = requestSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Solicitud inválida.' })
  const result = await runtime.chat(parsed.data.sessionId, parsed.data.message)
  return response.json(result)
})
app.use('/api', (_request, response) => response.status(404).json({ error: 'Ruta no encontrada.' }))

app.listen(port, () => console.log(`Agente disponible en http://localhost:${port}`))
