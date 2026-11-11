<<<<<<< HEAD
# Agente de registro como proveedor

Agente conversacional que lee solicitudes normalizadas, mapea campos contra un maestro, genera formularios y prepara paquetes para firma.

## Inicio local

Requisitos: Node.js 20+.

```bash
cp .env.example .env
npm install
npm run dev
```

Define `OPENCODE_API_KEY` en `.env` y abre `http://localhost:3000`. OpenCode Go está diseñado para agentes de programación y tráfico similar; antes de usarlo para registro de proveedores confirma con OpenCode que este caso de uso está permitido. El frontend y el backend arrancan con el mismo comando. La clave permanece en el backend: no envíes `.env`, no lo incluyas en el ZIP y usa variables de entorno privadas en el despliegue. Quien tenga acceso directo a tu equipo, al archivo o a la configuración del servidor podría verla.

## Verificación sin modelo

```bash
npm run demo
npm test
npm run typecheck
npm run lint
```

`npm run demo` limpia `out/`, procesa todos los fixtures y genera resultados deterministas salvo timestamps.

## API

- `POST /api/chat`: `{ "sessionId": "...", "message": "..." }`
- `GET /api/sessions/:id`: historial completo y llamadas a herramientas.
- `GET /api/health`: proveedor, modelo y estado de configuración sin exponer claves.

## Variables

| Variable | Uso |
|---|---|
| `OPENCODE_API_KEY` | Clave privada del backend para OpenCode Go |
| `OPENCODE_MODEL` | Modelo de OpenCode Go compatible con Messages; predeterminado `minimax-m3` |
| `PORT` | Puerto HTTP; predeterminado `3000` |
| `MAX_ITERATIONS` | Tope del ciclo por turno |
| `MAX_SESSION_TOKENS` | Presupuesto máximo por sesión |
| `LLM_TIMEOUT_MS` | Timeout del proveedor |

## Link de prueba

Pendiente de configurar en el proveedor de despliegue. La aplicación puede demostrarse localmente sin penalizar funcionalidad; el chat necesita una clave válida y `demo.ts` no.
=======
# ai_agent-supplier-register
>>>>>>> 2c2d94967010ad65fd42eac863cfe559a135f5c5
