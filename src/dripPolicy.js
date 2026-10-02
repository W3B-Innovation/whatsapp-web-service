/**
 * Reglas del goteo del envío masivo por QR: cadencia segura, esperas "humanas", franja nocturna y spintax.
 * Sin dependencias (ni Baileys ni red) para poder probarlas.
 */

const SAFE = { minDelay: 60_000, maxDelay: 120_000, batchSize: 12, batchPause: 240_000, batchPauseMax: 480_000 }
/** Aunque el CRM pida algo más rápido, nunca se baja de esto. */
const FLOOR = { minDelay: 15_000, batchPause: 60_000, batchSize: 3 }
export const rand = (min, max) => Math.floor(Math.random() * (max - min + 1) + min)

/** Cadencia recibida del CRM, validada y con los mínimos seguros. Sin datos válidos usa la más segura. */
export function normalizeDrip(config) {
    const c = config && typeof config === 'object' ? config : {}
    const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback)
    const minDelay = Math.max(FLOOR.minDelay, num(c.minDelay, SAFE.minDelay))
    const maxDelay = Math.max(minDelay, num(c.maxDelay, SAFE.maxDelay))
    const batchPause = Math.max(FLOOR.batchPause, num(c.batchPause, SAFE.batchPause))
    return {
        minDelay,
        maxDelay,
        batchSize: Math.max(FLOOR.batchSize, Math.round(num(c.batchSize, SAFE.batchSize))),
        batchPause,
        batchPauseMax: Math.max(batchPause, num(c.batchPauseMax, Math.round(batchPause * 2))),
    }
}

/** Espera entre dos mensajes: aleatoria dentro del rango y, una de cada ~12 veces, bastante más larga (como quien se distrae). */
export function humanDelay(drip) {
    const base = rand(drip.minDelay, drip.maxDelay)
    return Math.random() < 0.08 ? Math.round(base * (1.5 + Math.random() * 1.5)) : base
}

/** Tamaño del siguiente bloque: el configurado ±25 %. */
export function nextBatchSize(drip) {
    return Math.max(FLOOR.batchSize, Math.round(drip.batchSize * (0.75 + Math.random() * 0.5)))
}

/** Configuración de la franja sin envíos. "off" la desactiva. Formato "22-8" (hora de inicio y de fin). */
export function quietHoursConfig(env = process.env) {
    const raw = (env.BULK_QUIET_HOURS || '22-8').trim().toLowerCase()
    if (raw === 'off' || raw === 'false' || raw === '0') return null
    const m = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/)
    if (!m) return { start: 22, end: 8, timeZone: env.BULK_TIMEZONE || 'America/Mexico_City' }
    return { start: Number(m[1]) % 24, end: Number(m[2]) % 24, timeZone: env.BULK_TIMEZONE || 'America/Mexico_City' }
}

/** ¿Es hora de no enviar? (la franja puede cruzar la medianoche). */
export function isQuietTime(date = new Date(), config = quietHoursConfig()) {
    if (!config || config.start === config.end) return false
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: config.timeZone }).format(date)) % 24
    return config.start < config.end ? hour >= config.start && hour < config.end : hour >= config.start || hour < config.end
}

/**
 * Resuelve expresiones de Spintax en el texto, seleccionando aleatoriamente
 * una opción de cada grupo delimitado por llaves `{}` y separado por `|`.
 * Soporta anidación.
 */
export function resolveSpintax(text) {
    if (!text) return ''
    let result = text
    const regex = /\{([^{}]+)\}/
    while (regex.test(result)) {
        result = result.replace(regex, (match, choices) => {
            const options = choices.split('|')
            return options[Math.floor(Math.random() * options.length)]
        })
    }
    return result
}
