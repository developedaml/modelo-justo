export type Ventana = { kind: string; percentUsed: number; resetsAt?: string }
export type Lectura = {
  ventanas: Ventana[]
  contexto?: number
  costeUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'medidor-uso': {
      lectura: Lectura | null
      tick: number
      oculto: boolean
    }
  }
}
