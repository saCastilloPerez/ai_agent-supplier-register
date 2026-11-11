import { mkdir, readFile, writeFile, appendFile, copyFile, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import ExcelJS from 'exceljs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { z } from 'zod'

export type ToolContext = { directory: string; sessionId: string }
export type CampoSolicitado = { etiqueta: string; obligatorio: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string; requiere_confirmacion?: boolean; equivalente_pais?: string }
export type CampoMapeado = { etiqueta: string; ruta: string; valor: unknown; confianza: number; nota?: string; hoja?: string; celda_etiqueta?: string; celda_valor?: string; obligatorio: boolean }
export type CampoFaltante = { etiqueta: string; obligatorio: boolean; motivo: string; hoja?: string; celda_etiqueta?: string; celda_valor?: string }
export type Mapeo = { llenos: CampoMapeado[]; faltantes: CampoFaltante[]; requiere_confirmacion: CampoMapeado[] }

type Solicitud = { id: string; pais: string; cliente: string; formato: 'xlsx' | 'pdf' | 'portal' }
type Soporte = { tipo: string; archivo: string; vigencia_hasta: string | null; pais_emisor: string; descripcion: string }
type EstadoSoporte = 'presente' | 'ausente' | 'vencido'
type ChecklistSoporte = { tipo: string; estado: EstadoSoporte; vigencia_hasta: string | null }
export type ResumenPaquete = {
  ruta: string
  listo_para_firma: boolean
  solicitante: { cliente: string; pais: string }
  proveedor_registrado: { razon_social: string; pais: string }
  formato: 'xlsx' | 'pdf' | 'portal'
  checklist: ChecklistSoporte[]
  campos_faltantes: CampoFaltante[]
  requiere_confirmacion: CampoMapeado[]
  bloqueos_firma: Array<{ tipo: 'soporte_ausente' | 'soporte_vencido' | 'formato_no_soportado'; detalle: string }>
}
type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }
type ToolDefinition<T> = { description: string; args: Record<string, z.ZodType>; execute(args: T, ctx: ToolContext): Promise<string> }

const casoArgs = z.string().regex(/^[a-z0-9-]+$/).describe('Nombre seguro de la carpeta del caso en fixtures/reto-01/casos/')
const campoSchema = z.object({
  etiqueta: z.string(), obligatorio: z.boolean(), hoja: z.string().optional(), celda_etiqueta: z.string().optional(), celda_valor: z.string().optional(), requiere_confirmacion: z.boolean().optional(), equivalente_pais: z.string().optional()
})
const mapeadoSchema = z.object({
  etiqueta: z.string(), ruta: z.string(), valor: z.unknown(), confianza: z.number(), nota: z.string().optional(), hoja: z.string().optional(), celda_etiqueta: z.string().optional(), celda_valor: z.string().optional(), obligatorio: z.boolean()
})
const faltanteSchema = z.object({ etiqueta: z.string(), obligatorio: z.boolean(), motivo: z.string(), hoja: z.string().optional(), celda_etiqueta: z.string().optional(), celda_valor: z.string().optional() })
const mapeoSchema = z.object({ llenos: z.array(mapeadoSchema), faltantes: z.array(faltanteSchema), requiere_confirmacion: z.array(mapeadoSchema) })

const stringify = <T>(result: Resultado<T>) => JSON.stringify(result)
const rootFixtures = (ctx: ToolContext) => path.join(ctx.directory, 'fixtures', 'reto-01')
const caseDirectory = (ctx: ToolContext, caso: string) => path.join(rootFixtures(ctx), 'casos', caso)
const outputDirectory = (ctx: ToolContext, caso: string) => path.join(ctx.directory, 'out', caso)

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return 'El archivo JSON está corrupto o tiene una estructura inválida.'
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'No se encontró el caso o uno de sus archivos requeridos.'
  return error instanceof Error ? error.message : 'Ocurrió un error inesperado.'
}

async function logTool(ctx: ToolContext, caso: string, herramienta: string, ok: boolean, resumen: string): Promise<void> {
  const directory = outputDirectory(ctx, caso)
  await mkdir(directory, { recursive: true })
  const entry = JSON.stringify({ ts: new Date().toISOString(), herramienta, ok, resumen }) + '\n'
  await Promise.all([
    appendFile(path.join(directory, 'log.jsonl'), entry),
    appendFile(path.join(ctx.directory, 'out', 'log.jsonl'), entry)
  ])
}

async function guarded<T>(ctx: ToolContext, caso: string, herramienta: string, operation: () => Promise<T>): Promise<string> {
  if (!casoArgs.safeParse(caso).success) return stringify({ ok: false, error: 'Nombre de caso inválido.' })
  try {
    const data = await operation()
    await logTool(ctx, caso, herramienta, true, 'Ejecución completada')
    return stringify({ ok: true, data })
  } catch (error) {
    const message = errorMessage(error)
    await logTool(ctx, caso, herramienta, false, message).catch(() => undefined)
    return stringify({ ok: false, error: message })
  }
}

function getNestedValue(source: unknown, route: string): unknown {
  return route.split('.').reduce<unknown>((current, key) => {
    if (typeof current !== 'object' || current === null || !(key in current)) return undefined
    return (current as Record<string, unknown>)[key]
  }, source)
}

function countryIdentifier(country: string): string {
  return ({ CO: 'NIT', EC: 'RUC', PE: 'RUC', PA: 'RUC', HN: 'RTN' } as Record<string, string>)[country] ?? 'Identificación tributaria'
}

async function loadRequest(ctx: ToolContext, caso: string): Promise<{ solicitud: Solicitud; campos: CampoSolicitado[]; soportes: string[] }> {
  const directory = caseDirectory(ctx, caso)
  const solicitud = await readJson<Solicitud>(path.join(directory, 'solicitud.json'))
  const soportes = await readJson<string[]>(path.join(directory, 'soportes-exigidos.json'))
  const template = solicitud.formato === 'xlsx' ? 'plantilla-celdas.json' : 'plantilla-campos.json'
  const raw = await readJson<Array<Record<string, unknown>>>(path.join(directory, template))
  const campos = raw.map((field) => {
    const etiqueta = String(field.etiqueta)
    const ambiguous = ['Identificación tributaria', 'Número de identificación fiscal'].includes(etiqueta)
    return {
      etiqueta,
      obligatorio: typeof field.obligatorio === 'boolean' ? field.obligatorio : true,
      hoja: typeof field.hoja === 'string' ? field.hoja : undefined,
      celda_etiqueta: typeof field.celda_etiqueta === 'string' ? field.celda_etiqueta : undefined,
      celda_valor: typeof field.celda_valor === 'string' ? field.celda_valor : undefined,
      requiere_confirmacion: ambiguous || undefined,
      equivalente_pais: ambiguous ? countryIdentifier(solicitud.pais) : undefined
    }
  })
  return { solicitud, campos, soportes }
}

async function mapFields(ctx: ToolContext, caso: string, campos: CampoSolicitado[]): Promise<Mapeo> {
  const { solicitud } = await loadRequest(ctx, caso)
  const maestro = await readJson<Record<string, unknown>>(path.join(rootFixtures(ctx), 'repositorio', 'maestro.json'))
  const glossary = await readJson<Record<string, string>>(path.join(rootFixtures(ctx), 'glosario-campos.json'))
  const mapping: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  for (const field of campos) {
    const route = glossary[field.etiqueta]
    const value = route ? getNestedValue(maestro, route) : undefined
    if (!route || value === undefined || value === null || value === '') {
      mapping.faltantes.push({ ...field, motivo: route ? 'La ruta existe en el glosario pero no tiene valor en el maestro.' : 'La etiqueta no existe en el glosario.' })
      continue
    }
    const foreignTaxId = route === 'nit' && solicitud.pais !== 'CO'
    const mapped: CampoMapeado = {
      etiqueta: field.etiqueta, ruta: `maestro.${route}`, valor: value, confianza: foreignTaxId || field.requiere_confirmacion ? 0.7 : 1,
      nota: foreignTaxId ? `identificador extranjero: confirmar uso del NIT colombiano como ${countryIdentifier(solicitud.pais)}` : undefined,
      hoja: field.hoja, celda_etiqueta: field.celda_etiqueta, celda_valor: field.celda_valor, obligatorio: field.obligatorio
    }
    ;(foreignTaxId || field.requiere_confirmacion ? mapping.requiere_confirmacion : mapping.llenos).push(mapped)
  }
  return mapping
}

function mappingsMatch(actual: Mapeo, expected: Mapeo): boolean {
  const normalizedActual = JSON.parse(JSON.stringify(actual)) as Mapeo
  const normalizedExpected = JSON.parse(JSON.stringify(expected)) as Mapeo
  for (const key of ['llenos', 'faltantes', 'requiere_confirmacion'] as const) {
    const remaining: unknown[] = [...normalizedExpected[key]]
    for (const field of normalizedActual[key]) {
      const index = remaining.findIndex((candidate) => isDeepStrictEqual(field, candidate))
      if (index === -1) return false
      remaining.splice(index, 1)
    }
    if (remaining.length) return false
  }
  return true
}

function allMapped(mapping: Mapeo): CampoMapeado[] {
  return [...mapping.llenos, ...mapping.requiere_confirmacion]
}

function displayValue(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

async function generateXlsx(ctx: ToolContext, caso: string, mapping: Mapeo): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  const fields = [...allMapped(mapping), ...mapping.faltantes]
  for (const field of fields) {
    if (!field.hoja || !field.celda_etiqueta || !field.celda_valor) continue
    const sheet = workbook.getWorksheet(field.hoja) ?? workbook.addWorksheet(field.hoja)
    sheet.getCell(field.celda_etiqueta).value = field.etiqueta
    const mapped = 'valor' in field ? field : undefined
    sheet.getCell(field.celda_valor).value = mapped ? displayValue(mapped.valor) : ''
    sheet.getColumn(sheet.getCell(field.celda_etiqueta).col).width = 34
    sheet.getColumn(sheet.getCell(field.celda_valor).col).width = 42
  }
  const output = path.join(outputDirectory(ctx, caso), 'formulario.xlsx')
  await mkdir(path.dirname(output), { recursive: true })
  await workbook.xlsx.writeFile(output)
  return output
}

async function generatePdf(ctx: ToolContext, caso: string, mapping: Mapeo): Promise<string> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const { campos } = await loadRequest(ctx, caso)
  const mapped = new Map(allMapped(mapping).map((field) => [field.etiqueta, field]))
  let page = pdf.addPage([595, 842])
  let y = 792
  page.drawText('Formulario de registro de proveedor', { x: 48, y, size: 17, font: bold, color: rgb(0.08, 0.25, 0.18) })
  y -= 38
  for (const field of campos) {
    if (y < 70) { page = pdf.addPage([595, 842]); y = 792 }
    page.drawText(`${field.etiqueta}${field.obligatorio ? ' *' : ''}`, { x: 48, y, size: 10, font: bold })
    const entry = mapped.get(field.etiqueta)
    const value = entry ? displayValue(entry.valor) : '[FALTANTE]'
    page.drawText(value.slice(0, 82), { x: 48, y: y - 16, size: 10, font })
    y -= 50
  }
  const output = path.join(outputDirectory(ctx, caso), 'formulario.pdf')
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, await pdf.save())
  return output
}

async function generatePortalValues(ctx: ToolContext, caso: string, mapping: Mapeo): Promise<string> {
  const rows = allMapped(mapping).map((field) => `| ${field.etiqueta} | ${displayValue(field.valor)} | ${field.nota ?? 'Listo para copiar'} |`)
  const missing = mapping.faltantes.map((field) => `| ${field.etiqueta} | — | Faltante |`)
  const output = path.join(outputDirectory(ctx, caso), 'valores-portal.md')
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, `# Valores para portal\n\nFormato no soportado para automatización.\n\n| Campo | Valor | Estado |\n|---|---|---|\n${[...rows, ...missing].join('\n')}\n`)
  return output
}

export const leer_solicitud: ToolDefinition<{ caso: string }> = {
  description: 'Lee la solicitud, la plantilla y los soportes exigidos de un caso de registro de proveedor.',
  args: { caso: casoArgs },
  async execute({ caso }, ctx) {
    return guarded(ctx, caso, 'proveedor_leer_solicitud', async () => {
      const { solicitud, campos, soportes } = await loadRequest(ctx, caso)
      return { pais: solicitud.pais, cliente: solicitud.cliente, formato: solicitud.formato, campos, soportes }
    })
  }
}

export const mapear_campos: ToolDefinition<{ caso: string; campos: CampoSolicitado[] }> = {
  description: 'Cruza los campos solicitados con el glosario y el maestro sin inventar valores.',
  args: { caso: casoArgs, campos: z.array(campoSchema).describe('Campos devueltos por proveedor_leer_solicitud') },
  async execute({ caso, campos }, ctx) {
    return guarded(ctx, caso, 'proveedor_mapear_campos', () => mapFields(ctx, caso, campos))
  }
}

export const generar_formulario: ToolDefinition<{ caso: string; mapeo: Mapeo }> = {
  description: 'Genera el formulario Excel, PDF o los valores copiables para portal a partir del mapeo.',
  args: { caso: casoArgs, mapeo: mapeoSchema.describe('Mapeo devuelto por proveedor_mapear_campos') },
  async execute({ caso, mapeo }, ctx) {
    return guarded(ctx, caso, 'proveedor_generar_formulario', async () => {
      const { solicitud, campos } = await loadRequest(ctx, caso)
      const verifiedMapping = await mapFields(ctx, caso, campos)
      if (!mappingsMatch(mapeo, verifiedMapping)) throw new Error('El mapeo no coincide con los datos verificados del maestro.')
      const ruta = solicitud.formato === 'xlsx' ? await generateXlsx(ctx, caso, verifiedMapping) : solicitud.formato === 'pdf' ? await generatePdf(ctx, caso, verifiedMapping) : await generatePortalValues(ctx, caso, verifiedMapping)
      return { ruta: path.relative(ctx.directory, ruta), formato: solicitud.formato, soportado: solicitud.formato !== 'portal' }
    })
  }
}

export const armar_paquete: ToolDefinition<{ caso: string }> = {
  description: 'Arma el paquete para firma con formulario, soportes, checklist y borrador de correo.',
  args: { caso: casoArgs },
  async execute({ caso }, ctx) {
    return guarded(ctx, caso, 'proveedor_armar_paquete', async () => {
      const { solicitud, campos, soportes } = await loadRequest(ctx, caso)
      const maestro = await readJson<Record<string, unknown>>(path.join(rootFixtures(ctx), 'repositorio', 'maestro.json'))
      const mapping = await mapFields(ctx, caso, campos)
      const out = outputDirectory(ctx, caso)
      const packageDir = path.join(out, 'paquete')
      await mkdir(packageDir, { recursive: true })
      const generated = solicitud.formato === 'xlsx' ? path.join(out, 'formulario.xlsx') : solicitud.formato === 'pdf' ? path.join(out, 'formulario.pdf') : path.join(out, 'valores-portal.md')
      await copyFile(generated, path.join(packageDir, path.basename(generated))).catch(() => undefined)
      const index = await readJson<Soporte[]>(path.join(rootFixtures(ctx), 'repositorio', 'soportes', 'index.json'))
      const today = new Date()
      const checklist: ChecklistSoporte[] = []
      for (const required of soportes) {
        const support = index.find((item) => item.tipo === required)
        const expired = Boolean(support?.vigencia_hasta && new Date(`${support.vigencia_hasta}T23:59:59Z`) < today)
        const status = !support ? 'ausente' : expired ? 'vencido' : 'presente'
        checklist.push({ tipo: required, estado: status, vigencia_hasta: support?.vigencia_hasta ?? null })
        if (support) await copyFile(path.join(rootFixtures(ctx), 'repositorio', 'soportes', support.archivo), path.join(packageDir, support.archivo))
      }
      const checklistText = [
        '# Checklist para firma', '', '## Soportes', '', '| Soporte | Estado | Vigencia |', '|---|---|---|',
        ...checklist.map((item) => `| ${item.tipo} | ${item.estado} | ${item.vigencia_hasta ?? 'Sin vencimiento'} |`),
        '', '## Campos faltantes', '', ...(mapping.faltantes.length ? mapping.faltantes.map((field) => `- ${field.etiqueta}: ${field.motivo}`) : ['- Ninguno']),
        '', '## Campos por confirmar', '', ...(mapping.requiere_confirmacion.length ? mapping.requiere_confirmacion.map((field) => `- ${field.etiqueta}: ${field.nota ?? 'Requiere confirmación'}`) : ['- Ninguno'])
      ].join('\n')
      await writeFile(path.join(packageDir, 'checklist.md'), checklistText)
      await writeFile(path.join(packageDir, 'borrador-correo.md'), `# Borrador de correo\n\nAsunto: Registro de proveedor — ${solicitud.cliente}\n\nEstimados señores de ${solicitud.cliente}:\n\nAdjuntamos el formulario de registro y los soportes disponibles para su revisión y firma. Los datos bancarios no se reproducen en este correo.\n\nCordialmente,\nÁrea Administrativa\n`)
      const bloqueos_firma: ResumenPaquete['bloqueos_firma'] = []
      for (const item of checklist) {
        if (item.estado === 'ausente') bloqueos_firma.push({ tipo: 'soporte_ausente', detalle: item.tipo })
        if (item.estado === 'vencido') bloqueos_firma.push({ tipo: 'soporte_vencido', detalle: item.tipo })
      }
      if (solicitud.formato === 'portal') bloqueos_firma.push({ tipo: 'formato_no_soportado', detalle: 'portal' })
      const summary: ResumenPaquete = {
        ruta: path.relative(ctx.directory, packageDir),
        listo_para_firma: bloqueos_firma.length === 0,
        solicitante: { cliente: solicitud.cliente, pais: solicitud.pais },
        proveedor_registrado: { razon_social: String(maestro.razon_social), pais: String(maestro.pais) },
        formato: solicitud.formato,
        checklist,
        campos_faltantes: mapping.faltantes,
        requiere_confirmacion: mapping.requiere_confirmacion,
        bloqueos_firma
      }
      return summary
    })
  }
}

export const simular_envio: ToolDefinition<{ caso: string; confirmado: boolean }> = {
  description: 'Escribe un marcador de envío simulado únicamente tras confirmación explícita del usuario.',
  args: { caso: casoArgs, confirmado: z.boolean().describe('Verdadero solo si el usuario confirmó explícitamente en el turno inmediatamente anterior') },
  async execute({ caso, confirmado }, ctx) {
    if (!confirmado) return guarded(ctx, caso, 'proveedor_simular_envio', async () => { throw new Error('requiere confirmación explícita') })
    return guarded(ctx, caso, 'proveedor_simular_envio', async () => {
      await loadRequest(ctx, caso)
      const output = path.join(outputDirectory(ctx, caso), 'ENVIO-SIMULADO.md')
      await writeFile(output, `# Envío simulado\n\nCaso: ${caso}\n\nNo se realizó ninguna acción externa.\n`)
      return { ruta: path.relative(ctx.directory, output) }
    })
  }
}

export const proveedorTools = { leer_solicitud, mapear_campos, generar_formulario, armar_paquete, simular_envio }

export async function listCases(directory: string): Promise<string[]> {
  return (await readdir(path.join(directory, 'fixtures', 'reto-01', 'casos'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

export async function cleanOutput(directory: string): Promise<void> {
  await rm(path.join(directory, 'out'), { recursive: true, force: true })
  await mkdir(path.join(directory, 'out'), { recursive: true })
}
