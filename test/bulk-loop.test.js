import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.BULK_QUIET_HOURS = 'off'
const { processBulkSend, activeCampaigns, activeCampaignForAccount } = await import('../src/bulkService.js')

const contacts = (n) => Array.from({ length: n }, (_, i) => ({ phoneNumber: `52155000000${String(i).padStart(2, '0')}`, name: `C${i}` }))
const noWait = async () => {}

function run(n, { send, statusOf = () => 'open', wait = noWait, id = `camp-${Math.random()}` } = {}) {
    const reports = []
    const sent = []
    const done = processBulkSend(
        { accountId: 'acc-1', message: 'Hola {{nombre}}', contacts: contacts(n), bulkMessageId: id, dripConfig: { minDelay: 60000, maxDelay: 90000, batchSize: 5, batchPause: 120000 } },
        { send: async (...args) => { sent.push(args); return send ? send(...args) : { key: { id: `wa-${sent.length}` } } }, statusOf, wait, onReport: (r) => reports.push(r) }
    )
    return { done, reports, sent, id }
}

test('envía a todos, personaliza el mensaje y termina como completada', async () => {
    const { done, reports, sent } = run(4)
    await done
    assert.equal(sent.length, 4)
    assert.equal(sent[0][2], 'Hola C0')
    assert.equal(reports.at(-1).status, 'completed')
    assert.equal(reports.at(-1).sentCount, 4)
    // cada mensaje se envía con "escribiendo…" y exigiendo que el número tenga WhatsApp
    assert.deepEqual(sent[0][4], { typing: true, requireOnWhatsApp: true })
})

test('respeta las pausas: espera entre mensajes y pausa larga al cerrar un bloque', async () => {
    const waits = []
    const { done } = run(14, { wait: async (ms) => { waits.push(ms) } })
    await done
    const betweenMessages = waits.slice(1) // el primero es la pausa antes del primer mensaje
    assert.ok(waits[0] >= 4000 && waits[0] <= 15000, 'pausa inicial antes del primer mensaje')
    assert.ok(betweenMessages.every((w) => w >= 60000), 'nunca menos que el mínimo de la cadencia')
    assert.ok(betweenMessages.some((w) => w >= 120000 && w <= 240000 + 1), 'hay pausas largas de bloque')
})

test('tres fallos seguidos pausan la campaña con el motivo', async () => {
    const { done, reports, sent } = run(10, { send: async () => { throw new Error('boom') } })
    await done
    assert.equal(sent.length, 3)
    const last = reports.at(-1)
    assert.equal(last.status, 'paused')
    assert.equal(last.pauseReason.category, 'repeated_failures')
    assert.equal(activeCampaigns.size, 0)
})

test('un número sin WhatsApp falla ese contacto pero no pausa la campaña', async () => {
    const send = async (_a, number) => {
        if (number.endsWith('01') || number.endsWith('02') || number.endsWith('03') || number.endsWith('04')) {
            const e = new Error('El número no tiene WhatsApp')
            e.code = 'NOT_ON_WHATSAPP'
            throw e
        }
        return { key: { id: 'ok' } }
    }
    const { done, reports } = run(7, { send })
    await done
    const last = reports.at(-1)
    assert.equal(last.status, 'completed')
    assert.equal(last.failedCount, 4)
    assert.equal(last.sentCount, 3)
})

test('si la cuenta se desconecta, se pausa en vez de marcar todos como fallidos', async () => {
    let calls = 0
    const { done, reports } = run(6, {
        statusOf: () => (calls++ < 3 ? 'open' : 'close'),
    })
    await done
    const last = reports.at(-1)
    assert.equal(last.status, 'paused')
    assert.equal(last.pauseReason.category, 'disconnected')
    assert.equal(last.failedCount, 0)
})

test('pausar detiene el envío y deja pendiente al resto', async () => {
    const id = 'camp-pausa'
    let n = 0
    const { done, reports, sent } = run(6, {
        id,
        send: async () => {
            if (++n === 2) activeCampaigns.get(id).paused = true
            return { key: { id: 'x' } }
        },
    })
    await done
    assert.equal(sent.length, 2)
    assert.equal(reports.at(-1).status, 'paused')
    assert.equal(reports.at(-1).pauseReason, undefined)
})

test('los resultados que el CRM no recibió se reenvían en el siguiente aviso', async () => {
    // sin webhookUrl el aviso nunca "llega": el buffer crece y se conserva (con tope)
    const { done, reports } = run(5)
    await done
    assert.equal(reports.at(-1).results.length, 5)
})

test('una sola campaña por cuenta a la vez', async () => {
    const id = 'camp-ocupada'
    activeCampaigns.set(id, { accountId: 'acc-ocupada', paused: false, cancelled: false })
    assert.equal(activeCampaignForAccount('acc-ocupada'), id)
    assert.equal(activeCampaignForAccount('otra'), null)
    activeCampaigns.delete(id)
})
