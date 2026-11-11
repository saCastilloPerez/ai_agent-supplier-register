import { armar_paquete, cleanOutput, generar_formulario, leer_solicitud, listCases, mapear_campos, type CampoSolicitado, type Mapeo } from './src/tools/proveedor.js'

const ctx = { directory: process.cwd(), sessionId: 'demo' }
type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function run(): Promise<void> {
  await cleanOutput(ctx.directory)
  for (const caso of await listCases(ctx.directory)) {
    try {
      const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as Result<{ campos: CampoSolicitado[]; formato: string }>
      if (!request.ok) throw new Error(request.error)
      const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as Result<Mapeo>
      if (!mapping.ok) throw new Error(mapping.error)
      const form = JSON.parse(await generar_formulario.execute({ caso, mapeo: mapping.data }, ctx)) as Result<{ ruta: string }>
      const pack = JSON.parse(await armar_paquete.execute({ caso }, ctx)) as Result<{ listo_para_firma: boolean; checklist: { tipo: string; estado: string }[] }>
      console.log(JSON.stringify({ caso, formato: request.data.formato, formulario: form.ok ? form.data.ruta : form.error, llenos: mapping.data.llenos.length, faltantes: mapping.data.faltantes.map((item) => item.etiqueta), requiere_confirmacion: mapping.data.requiere_confirmacion.map((item) => item.etiqueta), paquete: pack.ok ? pack.data : pack.error }))
    } catch (error) {
      console.log(JSON.stringify({ caso, error: error instanceof Error ? error.message : 'Error inesperado' }))
    }
  }
}

await run()
