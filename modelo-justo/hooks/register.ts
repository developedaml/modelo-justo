import type { EngineInterface, Register } from 'claude-code'

// Modelo justo: en cada turno del chat principal, Haiku clasifica la petición
// como simple, normal o compleja, y el turno se ajusta a eso.
//
// Modos:
//   esfuerzo (por defecto): mantiene el modelo de la sesión y cambia solo el
//     esfuerzo (low / medium / high). No rompe la caché del prompt.
//   modelo: cambia también el modelo (haiku / sonnet / opus). Más ahorro en
//     tareas simples, pero cambiar de modelo hace perder la caché.
//
// Seguridad: solo usa la API del propio Claude Code. No abre conexiones, no
// ejecuta comandos, no lee archivos. Guarda solo sus ajustes y contadores.

type Nivel = 'simple' | 'normal' | 'compleja'
type Modo = 'esfuerzo' | 'modelo'

const MODELO: Record<Nivel, string> = { simple: 'haiku', normal: 'sonnet', compleja: 'opus' }
const ESFUERZO: Record<Nivel, 'low' | 'medium' | 'high'> = {
  simple: 'low',
  normal: 'medium',
  compleja: 'high',
}

const MIN_CARACTERES = 60
const MAX_CARACTERES = 4000

const CLASIFICADOR = `Clasifica la petición de un usuario a un asistente de programación según el razonamiento que necesita.

simple: una pregunta corta o de hecho, un saludo, un cambio trivial (renombrar, un typo, un comando conocido), leer o explicar algo pequeño.
normal: una tarea concreta de varios pasos: un bug acotado, una función o componente nuevo, una revisión de un archivo, una explicación con detalle.
compleja: diseño o arquitectura, depuración difícil o sin pista clara, cambios en muchos archivos, migraciones, seguridad, rendimiento, o una petición ambigua que exige planear.

Si dudas entre dos niveles, elige el más alto.
Responde con una sola palabra: simple, normal o compleja.

Petición:
`

// Elección por turno. Vive solo en memoria: se borra al acabar el turno.
const elecciones = new Map<string, Nivel>()

function leerNivel(texto: string): Nivel | undefined {
  const m = texto.toLowerCase().match(/\b(simple|normal|compleja)\b/)
  return m ? (m[1] as Nivel) : undefined
}

function estado(activo: boolean, modo: Modo, ultimo?: Nivel): string {
  if (!activo) return 'modelo justo: apagado'
  const base = `modelo justo: ${modo}`
  if (!ultimo) return base
  return `${base} · ${ultimo} → ${modo === 'modelo' ? MODELO[ultimo] : ESFUERZO[ultimo]}`
}

export const register: Register = on => {
  const leerAjustes = async ($: EngineInterface) => ({
    activo: ((await $.store.get('activo')) ?? true) === true,
    modo: ((await $.store.get('modo')) === 'modelo' ? 'modelo' : 'esfuerzo') as Modo,
  })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'modelo-justo',
        description: 'Ajusta esfuerzo o modelo según la petición: on, off, esfuerzo, modelo, estado',
        argumentHint: 'on | off | esfuerzo | modelo | estado',
      })
    } catch (err) {
      $.ui.toast(`modelo justo: no se pudo registrar el comando (${String(err)})`)
    }
    const { activo, modo } = await leerAjustes($)
    $.ui.status(estado(activo, modo))
    return next(e)
  })

  on('command.run', { command: 'modelo-justo' }, async ($, e) => ({
    text: await ejecutar($, e.args),
  }))

  // Respaldo: si la app no reconoce /modelo-justo como comando, el mensaje
  // llega como texto normal. Aquí se atrapa y se responde sin enviarlo al modelo.
  on('prompt.submit', async ($, e, next) => {
    const m = e.text.trim().match(/^\/modelo-justo(?:\s+(.*))?$/is)
    if (!m) return next(e)
    const respuesta = await ejecutar($, m[1] ?? '')
    $.ui.toast(respuesta.split('\n')[0] ?? respuesta)
    return { drop: respuesta }
  })

  async function ejecutar($: EngineInterface, args: string): Promise<string> {
    const arg = args.trim().toLowerCase()
    let { activo, modo } = await leerAjustes($)

    if (arg === 'on' || arg === 'off') {
      activo = arg === 'on'
      await $.store.set('activo', activo)
    } else if (arg === 'esfuerzo' || arg === 'modelo') {
      modo = arg
      activo = true
      await $.store.set('modo', modo)
      await $.store.set('activo', true)
    } else if (arg !== '' && arg !== 'estado') {
      return 'Uso: /modelo-justo on | off | esfuerzo | modelo | estado'
    }

    $.ui.status(estado(activo, modo))

    const c = async (n: Nivel) => Number((await $.store.get(`cuenta.${n}`)) ?? 0)
    const [s, n, x] = [await c('simple'), await c('normal'), await c('compleja')]
    const tabla =
      modo === 'modelo'
        ? 'simple → haiku · normal → sonnet · compleja → opus'
        : 'simple → low · normal → medium · compleja → high (mismo modelo)'
    return [
      `Modelo justo: ${activo ? 'encendido' : 'apagado'}, modo ${modo}.`,
      tabla,
      `Peticiones clasificadas: ${s} simples, ${n} normales, ${x} complejas.`,
    ].join('\n')
  }

  on('turn.start', async ($, e, next) => {
    // Solo el chat principal, solo peticiones escritas con algo de sustancia.
    if (e.agentId !== undefined) return next(e)
    const texto = e.text.trim()
    if (texto.length < MIN_CARACTERES || texto.startsWith('/')) return next(e)

    const { activo, modo } = await leerAjustes($)
    if (!activo) return next(e)

    const r = await $.model.complete({
      model: 'haiku',
      prompt: CLASIFICADOR + texto.slice(0, MAX_CARACTERES),
      maxTokens: 16,
      effort: 'low',
      timeoutMs: 8000,
    })
    // Si Haiku falla o responde algo raro, el turno sigue igual que siempre.
    const nivel = r.isAnswered ? leerNivel(r.text) : undefined
    if (nivel) {
      elecciones.set(e.turnId, nivel)
      const cuenta = Number((await $.store.get(`cuenta.${nivel}`)) ?? 0) + 1
      await $.store.set(`cuenta.${nivel}`, cuenta)
    }
    $.ui.status(estado(activo, modo, nivel))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const nivel = e.agentId === undefined ? elecciones.get(e.turnId) : undefined
    if (!nivel) return yield* next(e)

    const modo: Modo = (await $.store.get('modo')) === 'modelo' ? 'modelo' : 'esfuerzo'
    // Solo se toca el esfuerzo si el modelo lo admite (e.effort presente).
    const esfuerzo = e.effort !== undefined ? ESFUERZO[nivel] : undefined
    const cambio =
      modo === 'modelo'
        ? { ...e, model: MODELO[nivel], ...(esfuerzo ? { effort: esfuerzo } : {}) }
        : esfuerzo
          ? { ...e, effort: esfuerzo }
          : e
    return yield* next(cambio)
  })

  on('turn.complete', async ($, e, next) => {
    elecciones.delete(e.turnId)
    return next(e)
  })
}
