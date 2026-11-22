// Medidor de uso: una fila encima del prompt con el uso del plan (5 horas y
// 7 días), el llenado del contexto y el coste de la sesión.
//
// Seguridad: solo usa la API de Claude Code. No abre conexiones, no ejecuta
// comandos y no lee archivos. Guarda únicamente si la fila está oculta y qué
// avisos ya mostró.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCost, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import type { Lectura, Ventana } from '../types'

const CELDAS = 5
const BLOQUES = '▁▂▃▄▅▆▇█'
const AVISOS = [80, 95]
const NOMBRES: Record<string, string> = { five_hour: '5h', seven_day: 'semana', spend_limit: 'gasto' }
const ORDEN = ['five_hour', 'seven_day', 'spend_limit']

const lectura = atom({ plugin: 'medidor-uso', key: 'lectura' } as const, null as Lectura | null)
const tick = atom({ plugin: 'medidor-uso', key: 'tick' } as const, 0)
const oculto = atom({ plugin: 'medidor-uso', key: 'oculto' } as const, false)

type Trozo = { texto: string; color?: string; tenue?: boolean }

// ---------- lectura y avisos ----------

async function guardar(
  $: EngineInterface,
  rateLimits: readonly SessionRateLimit[],
  contexto: SessionContextUsage | undefined,
  coste: SessionCost | undefined,
): Promise<void> {
  const ventanas: Ventana[] = rateLimits
    .filter(w => Number.isFinite(w.percentUsed))
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
  await update($, lectura, () => ({
    ventanas,
    contexto: contexto?.percent,
    costeUsd: coste?.usd,
  }))
  await avisar($, ventanas)
}

// Un aviso por ventana, umbral y periodo (el periodo lo marca su hora de reinicio).
async function avisar($: EngineInterface, ventanas: Ventana[]): Promise<void> {
  const ahora = await $.clock.now()
  for (const w of ventanas) {
    const umbral = [...AVISOS].reverse().find(u => w.percentUsed >= u)
    if (umbral === undefined) continue
    const clave = `aviso.${w.kind}.${umbral}`
    const periodo = w.resetsAt ?? 'sin-reinicio'
    if ((await $.store.get(clave)) === periodo) continue
    await $.store.set(clave, periodo)
    const reinicio = horaReinicio(w)
    const cuando = reinicio > 0 ? `; se reinicia en ${cuentaAtras(reinicio - ahora)}` : ''
    $.ui.toast(`Uso de ${nombre(w.kind)} al ${Math.round(w.percentUsed)}%${cuando}`)
  }
}

async function detalle($: EngineInterface): Promise<string> {
  const l = await read($, lectura)
  if (!l) return 'Medidor de uso: todavía no hay lectura. Aparece tras la primera respuesta.'
  const ahora = await $.clock.now()
  const lineas = ordenar(l.ventanas, ahora).map(w => {
    const r = horaReinicio(w)
    return `${nombre(w.kind)}: ${Math.round(w.percentUsed)}%${r > 0 ? `, se reinicia en ${cuentaAtras(r - ahora)}` : ''}`
  })
  if (l.contexto !== undefined) lineas.push(`contexto: ${Math.round(l.contexto)}%`)
  if (l.costeUsd !== undefined) lineas.push(`coste estimado de esta sesión: $${l.costeUsd.toFixed(2)}`)
  if (lineas.length === 0) lineas.push('Sin datos de límites (puede que tu cuenta no los reporte).')
  return ['Medidor de uso', ...lineas].join('\n')
}

// ---------- el mod ----------

export const register: Register = on => {
  let reloj: Timer | undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command
      .register({
        name: 'uso',
        description: 'Medidor de uso: sin argumento muestra el detalle; on u off muestran u ocultan la fila',
        argumentHint: 'on | off',
      })
      .catch(() => {})
    const estabaOculto = (await $.store.get('oculto').catch(() => undefined)) === true
    await update($, oculto, () => estabaOculto)
    // Redibuja cada minuto para que la cuenta atrás avance.
    reloj?.cancel()
    reloj = $.clock.every(60_000, () => {
      void update($, tick, n => n + 1).catch(() => {})
    })
    const u = await $.session.usage().catch(() => null)
    if (u) await guardar($, u.rateLimits, u.context, u.cost).catch(() => {})
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await guardar($, e.rateLimits, e.context, e.cost).catch(() => {})
    return r
  })

  on('command.run', { command: 'uso' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      const ocultar = arg === 'off'
      await update($, oculto, () => ocultar)
      await $.store.set('oculto', ocultar).catch(() => {})
      return { text: ocultar ? 'Medidor de uso oculto. /uso on lo vuelve a mostrar.' : 'Medidor de uso visible.' }
    }
    return { text: await detalle($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick)
    const l = await read($, lectura)
    if (e.props.hasSurvey || !l || (await read($, oculto))) return next(e)

    const trozos = componer(l, await $.clock.now(), e.props.bodyColumns - 2)
    if (trozos.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" paddingX={1}>
        {trozos.map((t, i) => (
          <Text key={String(i)} color={t.color} dimColor={t.tenue} wrap="truncate">
            {t.texto}
          </Text>
        ))}
      </Box>
    )
  })
}

// ---------- dibujo (funciones puras) ----------

function componer(l: Lectura, ahora: number, columnas: number): Trozo[] {
  const ventanas = ordenar(l.ventanas, ahora)
  const partes: Trozo[][] = ventanas.map((w, i) => {
    const color = colorPara(w.percentUsed)
    const p: Trozo[] = [
      { texto: `${nombre(w.kind)} `, tenue: true },
      { texto: barra(w.percentUsed), color },
      { texto: ` ${Math.round(w.percentUsed)}%`, color },
    ]
    const r = horaReinicio(w)
    if (r > 0 && (i === 0 || w.percentUsed >= 75)) p.push({ texto: ` ${cuentaAtras(r - ahora)}`, tenue: true })
    return p
  })
  if (l.contexto !== undefined) {
    partes.push([
      { texto: 'contexto ', tenue: true },
      { texto: `${Math.round(l.contexto)}%`, color: colorPara(l.contexto) },
    ])
  }
  if (l.costeUsd !== undefined && l.costeUsd > 0) partes.push([{ texto: `$${l.costeUsd.toFixed(2)}`, tenue: true }])

  // Si no cabe, se quitan partes desde el final, pero nunca la primera.
  while (partes.length > 1 && ancho(partes) > columnas) partes.splice(partes.length - 1, 1)
  if (partes.length === 0) return []

  const out: Trozo[] = [{ texto: '⏱ ', tenue: true }]
  partes.forEach((p, i) => {
    if (i > 0) out.push({ texto: ' · ', tenue: true })
    out.push(...p)
  })
  return out
}

function ancho(partes: Trozo[][]): number {
  return 2 + [...partes.map(p => p.map(t => t.texto).join('')).join(' · ')].length
}

function ordenar(ventanas: Ventana[], ahora: number): Ventana[] {
  return ventanas
    .filter(w => {
      const r = horaReinicio(w)
      return !(r > 0 && r <= ahora)
    })
    .sort((a, b) => rango(a.kind) - rango(b.kind))
}

function barra(pct: number): string {
  const lleno = (Math.min(Math.max(pct, 0), 100) / 100) * CELDAS
  let out = ''
  for (let i = 0; i < CELDAS; i++) {
    const celda = Math.min(Math.max(lleno - i, 0), 1)
    out += BLOQUES[Math.round(celda * (BLOQUES.length - 1))]
  }
  return out
}

function colorPara(pct: number): string {
  if (pct >= 90) return 'red'
  if (pct >= 75) return 'yellow'
  return 'green'
}

function cuentaAtras(ms: number): string {
  const min = Math.max(0, Math.ceil(ms / 60_000))
  if (min < 1) return 'ya'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h${String(min % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

function horaReinicio(w: Ventana): number {
  const ms = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(ms) ? ms : 0
}

function nombre(kind: string): string {
  const conocido = NOMBRES[kind]
  if (conocido) return conocido
  for (const base of ['five_hour', 'seven_day']) {
    if (kind.startsWith(base + '_')) return `${NOMBRES[base]} ${kind.slice(base.length + 1).replace(/_/g, ' ')}`
  }
  return kind.replace(/_/g, ' ')
}

function rango(kind: string): number {
  const i = ORDEN.indexOf(kind)
  if (i >= 0) return i * 10
  for (let j = 0; j < ORDEN.length; j++) if (kind.startsWith(ORDEN[j] + '_')) return j * 10 + 1
  return ORDEN.length * 10
}
