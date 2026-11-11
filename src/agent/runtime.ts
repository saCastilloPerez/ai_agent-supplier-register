import { z } from 'zod'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { proveedorTools, type Mapeo, type ResumenPaquete, type ToolContext } from '../tools/proveedor.js'
import type { LlmAdapter, Message, ToolCallBlock, ToolResultBlock, ToolSpec } from '../llm/adapter.js'

export type VisibleToolCall = { name: string; arguments: unknown; result: unknown }
export type HistoryItem = { role: 'user' | 'assistant' | 'tool'; content: string; toolCall?: VisibleToolCall; needsConfirmation?: boolean }
type Session = { messages: Message[]; history: HistoryItem[]; mappings: Map<string, Mapeo>; usedTokens: number; pendingCase?: string; busy: boolean }
export type ChatResponse = { reply: string; toolCalls: VisibleToolCall[]; needsConfirmation: boolean }

type RuntimeOptions = { directory: string; maxIterations: number; maxSessionTokens: number }
type ToolResult = { ok: boolean; data?: unknown }
const confirmation = /^(s[ií]|confirmo|confirmar|de acuerdo|adelante|autorizo|(?:s[ií],?\s*)?(?:simula|simular|env[ií]a)|confirmo (?:la simulaci[oó]n|el env[ií]o))[.!\s]*$/i
const rejection = /^(no|no,? gracias|rechazo|rechazar|cancelar|cancelo|no enviar|no simular)[.!\s]*$/i

export class AgentRuntime {
  private readonly sessions = new Map<string, Session>()
  private readonly specs: ToolSpec[]

  constructor(private readonly adapter: LlmAdapter, private readonly options: RuntimeOptions) {
    this.specs = Object.entries(proveedorTools).map(([name, tool]) => ({ name: `proveedor_${name}`, description: tool.description, inputSchema: z.toJSONSchema(z.object(tool.args)) as Record<string, unknown> }))
  }

  history(sessionId: string): HistoryItem[] { return this.sessions.get(sessionId)?.history ?? [] }

  private packageSummary(calls: VisibleToolCall[]): { caso: string; resumen: ResumenPaquete } | null {
    const packages = calls.filter((call) => call.name === 'proveedor_armar_paquete')
    if (packages.length !== 1) return null
    const args = z.object({ caso: z.string() }).safeParse(packages[0].arguments)
    const result = packages[0].result as ToolResult
    if (!args.success || !result.ok || !result.data) return null
    return { caso: args.data.caso, resumen: result.data as ResumenPaquete }
  }

  private packageReply({ caso, resumen }: { caso: string; resumen: ResumenPaquete }): string {
    const llenos = 'Los valores llenos provienen exclusivamente del maestro verificado.'
    const faltantes = resumen.campos_faltantes.length ? `Campos faltantes: ${resumen.campos_faltantes.map((field) => field.etiqueta).join(', ')}.` : 'Campos faltantes: ninguno.'
    const confirmaciones = resumen.requiere_confirmacion.length ? `Requieren confirmación: ${resumen.requiere_confirmacion.map((field) => field.etiqueta).join(', ')}.` : 'Requieren confirmación: ninguna.'
    const bloqueos = resumen.bloqueos_firma.length ? `Bloqueos de firma: ${resumen.bloqueos_firma.map((item) => `${item.tipo.replaceAll('_', ' ')} (${item.detalle})`).join(', ')}.` : 'No hay bloqueos de firma.'
    const formato = resumen.formato === 'portal' ? 'El portal no se automatiza; se generaron valores para copiar.' : `Formulario ${resumen.formato.toUpperCase()} generado.`
    return [
      `Caso ${caso} procesado.`,
      `Solicitante: ${resumen.solicitante.cliente} (${resumen.solicitante.pais}).`,
      `Proveedor registrado: ${resumen.proveedor_registrado.razon_social} (${resumen.proveedor_registrado.pais}).`,
      formato,
      llenos,
      faltantes,
      confirmaciones,
      bloqueos,
      `Paquete: ${resumen.ruta}. Listo para firma: ${resumen.listo_para_firma ? 'sí' : 'no'}.`,
      'No se envió ni firmó nada.'
    ].join('\n')
  }

  private getSession(id: string): Session {
    let session = this.sessions.get(id)
    if (!session) { session = { messages: [], history: [], mappings: new Map(), usedTokens: 0, busy: false }; this.sessions.set(id, session) }
    return session
  }

  async chat(sessionId: string, message: string): Promise<ChatResponse> {
    const session = this.getSession(sessionId)
    if (session.busy) return { reply: 'La sesión ya está procesando otro mensaje.', toolCalls: [], needsConfirmation: false }
    session.busy = true
    const toolCalls: VisibleToolCall[] = []
    const priorPending = session.pendingCase
    session.pendingCase = undefined
    session.history.push({ role: 'user', content: message })
    session.messages.push({ role: 'user', content: message })
    const finish = (text: string): ChatResponse => {
      const packageSummary = this.packageSummary(toolCalls)
      if (packageSummary) session.pendingCase = packageSummary.caso
      const deterministicText = packageSummary ? this.packageReply(packageSummary) : text
      const reply = session.pendingCase ? `${deterministicText}\n\n¿Confirmas simular el envío del caso ${session.pendingCase}? No se enviará nada al cliente.` : deterministicText
      const lastMessage = session.messages.at(-1)
      if (lastMessage?.role === 'assistant') session.messages[session.messages.length - 1] = { role: 'assistant', content: reply }
      else session.messages.push({ role: 'assistant', content: reply })
      session.history.push({ role: 'assistant', content: reply, needsConfirmation: Boolean(session.pendingCase) })
      return { reply, toolCalls, needsConfirmation: Boolean(session.pendingCase) }
    }
    try {
      if (priorPending && confirmation.test(message.trim())) {
        const result = await proveedorTools.simular_envio.execute({ caso: priorPending, confirmado: true }, { directory: this.options.directory, sessionId })
        const call = { name: 'proveedor_simular_envio', arguments: { caso: priorPending, confirmado: true }, result: JSON.parse(result) as unknown }
        toolCalls.push(call)
        session.history.push({ role: 'tool', content: result, toolCall: call })
        const parsed = JSON.parse(result) as { ok: boolean; error?: string }
        const reply = parsed.ok ? `Envío simulado registrado para ${priorPending}. No se envió nada al cliente.` : `No se pudo simular el envío: ${parsed.error ?? 'error desconocido'}.`
        session.messages.push({ role: 'assistant', content: reply })
        session.history.push({ role: 'assistant', content: reply })
        return { reply, toolCalls, needsConfirmation: false }
      }
      if (priorPending && rejection.test(message.trim())) {
        const reply = `Simulación cancelada para ${priorPending}. No se envió nada al cliente.`
        session.messages.push({ role: 'assistant', content: reply })
        session.history.push({ role: 'assistant', content: reply })
        return { reply, toolCalls, needsConfirmation: false }
      }
      let lastText = ''
      for (let iteration = 0; iteration < this.options.maxIterations; iteration++) {
        const remaining = this.options.maxSessionTokens - session.usedTokens
        if (remaining < 256) { lastText = 'Se alcanzó el límite de tokens de esta sesión. Inicia otra sesión para continuar.'; break }
        const response = await this.adapter.enviar(session.messages, this.specs, Math.min(1500, remaining), sessionId)
        session.usedTokens += response.inputTokens + response.outputTokens
        session.messages.push({ role: 'assistant', content: response.content })
        const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        if (text) lastText = text
        const calls = response.content.filter((block): block is ToolCallBlock => block.type === 'tool_use')
        if (!calls.length) {
          return finish(lastText || 'No se obtuvo una respuesta del modelo.')
        }
        const results: ToolResultBlock[] = []
        for (const call of calls) {
          const result = await this.executeTool(call, sessionId)
          const resultData = JSON.parse(result) as { ok: boolean; data?: unknown }
          const input = z.object({ caso: z.string() }).safeParse(call.input)
          if (call.name === 'proveedor_mapear_campos' && resultData.ok && input.success) session.mappings.set(input.data.caso, resultData.data as Mapeo)
          const trustedMapping = call.name === 'proveedor_generar_formulario' && input.success ? session.mappings.get(input.data.caso) : undefined
          const visibleArgs = trustedMapping && input.success ? { caso: input.data.caso, mapeo: trustedMapping } : call.input
          const visible = { name: call.name, arguments: visibleArgs, result: resultData }
          toolCalls.push(visible)
          session.history.push({ role: 'tool', content: result, toolCall: visible })
          results.push({ type: 'tool_result', tool_use_id: call.id, content: result, is_error: !((visible.result as { ok?: boolean }).ok) })
        }
        session.messages.push({ role: 'user', content: results })
      }
      const reply = `${lastText ? `${lastText}\n\n` : ''}Se alcanzó el límite de ejecución; revisa las herramientas y continúa en otro turno.`
      return finish(reply)
    } catch {
      const completedPackage = toolCalls.some((call) => call.name === 'proveedor_armar_paquete' && z.object({ ok: z.literal(true) }).safeParse(call.result).success)
      const reply = completedPackage ? 'El paquete se preparó, pero no fue posible obtener el resumen del modelo. Revisa el resultado de las herramientas.' : 'No fue posible completar la solicitud. Comprueba la configuración del proveedor y vuelve a intentarlo.'
      session.messages = []
            return finish(reply)
    } finally { session.busy = false }
  }

  private async executeTool(call: ToolCallBlock, sessionId: string): Promise<string> {
    const name = call.name.replace(/^proveedor_/, '') as keyof typeof proveedorTools
    const tool = proveedorTools[name]
    const requestedCase = z.object({ caso: z.string() }).safeParse(call.input)
    const trustedMapping = name === 'generar_formulario' && requestedCase.success ? this.getSession(sessionId).mappings.get(requestedCase.data.caso) : undefined
    const args = trustedMapping && requestedCase.success ? { caso: requestedCase.data.caso, mapeo: trustedMapping } : call.input
    const input = tool ? z.object(tool.args).safeParse(args) : null
    if (!tool || !input?.success || name === 'simular_envio') {
      const error = name === 'simular_envio' ? 'requiere confirmación explícita en el turno inmediatamente anterior' : 'Herramienta o argumentos inválidos.'
      await mkdir(path.join(this.options.directory, 'out'), { recursive: true })
      await appendFile(path.join(this.options.directory, 'out', 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), herramienta: call.name, ok: false, resumen: error }) + '\n')
      return JSON.stringify({ ok: false, error })
    }
    const ctx: ToolContext = { directory: this.options.directory, sessionId }
    switch (name) {
      case 'leer_solicitud': return proveedorTools.leer_solicitud.execute(input.data as Parameters<typeof proveedorTools.leer_solicitud.execute>[0], ctx)
      case 'mapear_campos': return proveedorTools.mapear_campos.execute(input.data as Parameters<typeof proveedorTools.mapear_campos.execute>[0], ctx)
      case 'generar_formulario': return proveedorTools.generar_formulario.execute(input.data as Parameters<typeof proveedorTools.generar_formulario.execute>[0], ctx)
      case 'armar_paquete': return proveedorTools.armar_paquete.execute(input.data as Parameters<typeof proveedorTools.armar_paquete.execute>[0], ctx)
      default: return JSON.stringify({ ok: false, error: 'Herramienta no disponible.' })
    }
  }
}
