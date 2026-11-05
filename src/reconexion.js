// Cuándo volver a intentar después de que se cae la conexión. Sin dependencias
// de Baileys para poder probarlo solo.

/** Esperas entre intentos: después de la última se repite la última. */
export const ESPERAS_MS = [5000, 15000, 30000, 60000, 120000, 300000]

/** Una conexión que duró esto ya era estable: la cuenta de intentos empieza de nuevo. */
export const ESTABLE_MS = 60000

/** 440: otra conexión tomó la sesión. Reintentar rápido sería pelearse con ella. */
const ESPERA_REEMPLAZADA_MS = 300000
const MAX_INTENTOS_REEMPLAZADA = 6

/**
 * WhatsApp cerró o rechazó la sesión: reintentar no sirve.
 * 401 sesión cerrada, 403 cuenta bloqueada, 405 conexión rechazada, 411 multidispositivo.
 */
const SIN_REINTENTO = new Set([401, 403, 405, 411])

/**
 * Cuánto esperar antes del intento dado (desde 0), o null para no reintentar.
 * Un código desconocido se reintenta: las credenciales siguen guardadas y un
 * error de red sin clasificar llega como 500 o sin código.
 */
export function esperaDeReconexion(statusCode, intento = 0) {
    if (SIN_REINTENTO.has(statusCode)) return null
    if (statusCode === 440) {
        return intento < MAX_INTENTOS_REEMPLAZADA ? ESPERA_REEMPLAZADA_MS : null
    }
    return ESPERAS_MS[Math.min(intento, ESPERAS_MS.length - 1)]
}
