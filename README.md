# modelo-justo

Mod para Claude Code. En cada petición del chat principal, Haiku la clasifica como **simple**, **normal** o **compleja**, y el turno se ajusta a eso.

- **Modo esfuerzo** (por defecto): mantiene el modelo de la sesión y cambia solo el esfuerzo: `low`, `medium` o `high`. No rompe la caché del prompt.
- **Modo modelo**: cambia también el modelo: Haiku, Sonnet u Opus.

Solo clasifica mensajes de 60 caracteres o más que no empiecen por `/`, y no toca los subagentes. Si Haiku falla o tarda más de 8 segundos, el turno sigue igual que siempre.

## Instalar

En una sesión de Claude Code (terminal o pestaña Code de Claude Desktop):

```
/plugin marketplace add developedaml/modelo-justo
/plugin install modelo-justo@mods-modelo-justo
```

## Uso

```
/modelo-justo estado     muestra el modo y cuántas peticiones clasificó
/modelo-justo on | off   enciende o apaga
/modelo-justo esfuerzo   cambia solo el esfuerzo (por defecto)
/modelo-justo modelo     cambia también el modelo
```

## Qué hace y qué no

Solo usa la API de Claude Code. No abre conexiones de red, no ejecuta comandos y no lee archivos. Guarda únicamente sus ajustes y contadores. Cada mensaje clasificado cuesta una llamada pequeña a Haiku.

Licencia MIT.
