import { sendMessage, getStatus } from './whatsappService.js'
import fetch from 'node-fetch'
import { webhookHeaders } from './webhookAuth.js'
import { normalizeDrip, humanDelay, nextBatchSize, quietHoursConfig, isQuietTime, resolveSpintax, rand } from './dripPolicy.js'

export { normalizeDrip, humanDelay, nextBatchSize, quietHoursConfig, isQuietTime, resolveSpintax }

/**
 * Envío masivo por cuentas vinculadas por QR (Baileys). Este canal NO es el oficial: si el envío se parece a un
 * programa, WhatsApp restringe o banea el número. Por eso el envío intenta parecerse a una persona:
 *   - pausas largas y variables entre mensajes, con alguna más larga de vez en cuando
 *   - bloques de tamaño irregular con pausas largas entre ellos
 *   - "escribiendo…" antes de cada mensaje, en proporción a su largo
 *   - nunca se envía de madrugada (por defecto 22:00-08:00 hora de México; BULK_QUIET_HOURS="off" lo desactiva)
 *   - no se escribe a números que no tienen WhatsApp
 *   - se detiene solo si la cuenta se desconecta o fallan varios envíos seguidos
 * La cadencia llega desde el CRM (que la fija en el servidor); aquí solo se limita a mínimos seguros.
 */

const MAX_UNREPORTED = 200
const MAX_CONSECUTIVE_FAILURES = 3
const RECONNECT_WAIT_MS = 2 * 60_000
const HEARTBEAT_MS = 5 * 60_000

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Reporta el progreso al CRM (webhook existente). Devuelve true si el CRM lo recibió. */
async function updateBulkProgress(webhookUrl, payload) {
    if (!webhookUrl) return false
    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: webhookHeaders(webhookUrl),
            body: JSON.stringify({ type: 'bulk_progress', ...payload }),
        })
        if (!response.ok) {
            const errBody = await response.text().catch(() => '')
            console.error(`[Bulk] Webhook error (${response.status}): ${errBody}`)
            return false
        }
        return true
    } catch (e) {
        console.error('[Bulk] Error reporting progress:', e.message)
        return false
    }
}

export const activeCampaigns = new Map()

/** ¿Hay ya una campaña activa en esta cuenta? (dos a la vez duplicarían el ritmo y delatarían el envío automático) */
export function activeCampaignForAccount(accountId) {
    for (const [id, state] of activeCampaigns) if (state.accountId === accountId) return id
    return null
}

/** Espera `ms` pero se corta en cuanto la campaña se pausa o cancela (así "Pausar" actúa al instante, no al terminar la espera). */
async function interruptibleDelay(ms, bulkMessageId) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        const state = activeCampaigns.get(bulkMessageId)
        if (!state || state.paused || state.cancelled) return
        await delay(Math.min(5_000, end - Date.now()))
    }
}

const isConnectionError = (error) => /no está conectado|not connected|connection closed|connection lost/i.test(error?.message || '')

/**
 * Procesa el envío masivo en bucle con goteo (drip feeding)
 */
export async function processBulkSend(data, deps = {}) {
    // Inyectable para pruebas: el envío real, el estado de la cuenta, las esperas y el aviso al CRM
    const send = deps.send ?? sendMessage
    const statusOf = deps.statusOf ?? getStatus
    const wait = deps.wait ?? interruptibleDelay
    const onReport = deps.onReport ?? (() => {})
    const { accountId, companyId, message, contacts, bulkMessageId, customTemplate, webhookUrl } = data
    const drip = normalizeDrip(data.dripConfig)
    const quiet = quietHoursConfig(process.env, data.timeZone || data.timezone || data.dripConfig?.timezone)

    console.log(`[Bulk] 🚀 Campaña ${bulkMessageId}: ${contacts.length} contactos, cuenta ${accountId}, ${Math.round(drip.minDelay / 1000)}-${Math.round(drip.maxDelay / 1000)} s entre mensajes`)

    activeCampaigns.set(bulkMessageId, { status: 'sending', accountId, paused: false, cancelled: false })

    let sentCount = 0
    let failedCount = 0
    let consecutiveFailures = 0
    let unreported = []
    let batchLimit = nextBatchSize(drip)
    let inBatch = 0

    /** Avisa al CRM con lo que aún no sabe; si no lo recibe, lo conserva para el siguiente aviso. */
    const report = async (status, extra = {}) => {
        onReport({ status, sentCount, failedCount, results: unreported.slice(), ...extra })
        const ok = await updateBulkProgress(webhookUrl, { bulkMessageId, sentCount, failedCount, results: unreported, status, ...extra })
        if (ok) unreported = []
        else if (unreported.length > MAX_UNREPORTED) unreported = unreported.slice(-MAX_UNREPORTED)
    }
    const stop = async (status, pauseReason) => {
        await report(status, pauseReason ? { pauseReason } : {})
        activeCampaigns.delete(bulkMessageId)
    }

    // Pausa corta antes del primer mensaje: no arrancar en el mismo instante en que se pulsa "enviar"
    await wait(rand(4_000, 15_000), bulkMessageId)

    for (let i = 0; i < contacts.length; i++) {
        // Pausa o cancelación pedida por el usuario
        let state = activeCampaigns.get(bulkMessageId)
        if (!state || state.paused || state.cancelled) {
            const finalStatus = state?.cancelled ? 'cancelled' : 'paused'
            console.log(`[Bulk] Campaña ${bulkMessageId} interrumpida. Estado: ${finalStatus}`)
            await stop(finalStatus)
            return
        }

        // Franja nocturna: no se envía; se espera avisando al CRM cada pocos minutos para que no parezca detenida
        if (isQuietTime(new Date(), quiet)) {
            console.log(`[Bulk] 🌙 Franja sin envíos (${quiet.start}:00-${quiet.end}:00 ${quiet.timeZone}); esperando para ${bulkMessageId}`)
            while (isQuietTime(new Date(), quiet)) {
                await report('sending', { note: `Pausa nocturna: el envío continúa a las ${String(quiet.end).padStart(2, '0')}:00 (hora ${quiet.timeZone === 'America/Mexico_City' ? 'de México' : quiet.timeZone}) para cuidar la cuenta.` })
                await wait(HEARTBEAT_MS, bulkMessageId)
                state = activeCampaigns.get(bulkMessageId)
                if (!state || state.paused || state.cancelled) break
            }
            i--
            continue
        }

        // Cuenta desconectada: se espera un poco a que reconecte y, si no, se pausa (no se marcan fallidos todos los contactos)
        if (statusOf(accountId) !== 'open') {
            for (let n = 0; n < RECONNECT_WAIT_MS / 10_000 && statusOf(accountId) !== 'open'; n++) await wait(10_000, bulkMessageId)
            if (statusOf(accountId) !== 'open') {
                console.warn(`[Bulk] Cuenta ${accountId} desconectada: se pausa ${bulkMessageId}`)
                await stop('paused', { category: 'disconnected', message: 'La cuenta de WhatsApp se desconectó. Vuelve a vincularla con el QR y pulsa «Reanudar»: el envío sigue donde se quedó.' })
                return
            }
        }

        const contact = contacts[i]
        const name = contact.name || 'Cliente'
        let personalizedMessage = message.replace(/\{\{nombre\}\}/gi, name).replace(/\{\{name\}\}/gi, name)
        // Variaciones de texto (Spintax): evitan mandar el mismo mensaje idéntico a todos
        personalizedMessage = resolveSpintax(personalizedMessage)
        const cleanNumber = contact.phoneNumber.replace(/\D/g, '')

        let sentThisRound = false
        try {
            const media = customTemplate?.media
            const result = await send(accountId, cleanNumber, personalizedMessage, media, { typing: true, requireOnWhatsApp: true })

            sentCount++
            sentThisRound = true
            consecutiveFailures = 0
            unreported.push({ phoneNumber: contact.phoneNumber, status: 'sent', messageId: result?.key?.id })
            console.log(`[Bulk] [${i + 1}/${contacts.length}] Mensaje enviado a ${cleanNumber}`)

            // Se notifica el mensaje para que aparezca en la bandeja (business_messages / business_conversations)
            if (webhookUrl && result?.key?.id) {
                fetch(webhookUrl, {
                    method: 'POST',
                    headers: webhookHeaders(webhookUrl),
                    body: JSON.stringify({
                        accountId,
                        companyId: companyId || null,
                        fromMe: true,
                        remoteJid: `${cleanNumber}@s.whatsapp.net`,
                        text: personalizedMessage,
                        timestamp: Math.floor(Date.now() / 1000),
                        messageId: result.key.id,
                        bulkMessageId,
                        media: media ? { url: media.url, type: media.type || 'image' } : null,
                    }),
                }).then((res) => {
                    if (!res.ok) console.error(`[Bulk Webhook Message] Error notificando el mensaje a ${cleanNumber} (${res.status})`)
                }).catch((err) => console.error(`[Bulk Webhook Message] Error notificando el mensaje a ${cleanNumber}:`, err.message))
            }
        } catch (error) {
            console.error(`[Bulk] [${i + 1}/${contacts.length}] ❌ ${contact.phoneNumber}:`, error.message)
            failedCount++
            const notOnWhatsApp = error.code === 'NOT_ON_WHATSAPP'
            unreported.push({
                phoneNumber: contact.phoneNumber,
                status: 'failed',
                error: notOnWhatsApp ? 'El número no tiene WhatsApp.' : error.message,
            })
            // Un número sin WhatsApp es un dato malo, no un problema de la cuenta; una desconexión se trata arriba
            if (!notOnWhatsApp && !isConnectionError(error)) consecutiveFailures++
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.warn(`[Bulk] ${consecutiveFailures} fallos seguidos: se pausa ${bulkMessageId}`)
                await stop('paused', { category: 'repeated_failures', message: `Fallaron ${consecutiveFailures} envíos seguidos; WhatsApp podría estar limitando la cuenta. Abre WhatsApp en el teléfono, comprueba que funciona con normalidad y pulsa «Reanudar».` })
                return
            }
            // No se envió nada (número sin WhatsApp): no hace falta esperar como tras un mensaje real
            if (notOnWhatsApp) {
                await report(i === contacts.length - 1 ? finalStatus(sentCount, failedCount) : 'sending', { note: null })
                if (i < contacts.length - 1) await wait(rand(2_000, 6_000), bulkMessageId)
                continue
            }
        }

        const isLast = i === contacts.length - 1
        await report(isLast ? finalStatus(sentCount, failedCount, contacts.length) : 'sending', { note: null })

        // Espera entre mensajes (goteo): normal, o pausa larga al cerrar un bloque
        if (!isLast) {
            inBatch += sentThisRound ? 1 : 0
            let waitTime
            if (inBatch >= batchLimit) {
                waitTime = rand(drip.batchPause, drip.batchPauseMax)
                inBatch = 0
                batchLimit = nextBatchSize(drip)
                console.log(`[Bulk] ⏳ Pausa de bloque de ${Math.round(waitTime / 60_000)} min tras ${i + 1} mensajes`)
                await report('sending', { note: `Pausa de ${Math.max(1, Math.round(waitTime / 60_000))} min entre bloques para cuidar la cuenta.` })
            } else {
                waitTime = humanDelay(drip)
            }
            await wait(waitTime, bulkMessageId)
        }
    }

    activeCampaigns.delete(bulkMessageId)
    console.log(`[Bulk] ✅ Campaña ${bulkMessageId} finalizada: ${sentCount} OK, ${failedCount} ERR`)
}

function finalStatus(sentCount, failedCount, total) {
    return sentCount === 0 && failedCount > 0 ? 'failed' : 'completed'
}
