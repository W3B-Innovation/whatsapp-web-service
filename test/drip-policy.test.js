import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeDrip, humanDelay, nextBatchSize, quietHoursConfig, isQuietTime, resolveSpintax } from '../src/dripPolicy.js'

test('sin configuración válida usa la cadencia más segura', () => {
    for (const bad of [undefined, null, 'x', {}, { minDelay: -5, maxDelay: 'a' }]) {
        const d = normalizeDrip(bad)
        assert.equal(d.minDelay, 60_000)
        assert.equal(d.maxDelay, 120_000)
        assert.ok(d.batchPause >= 240_000)
    }
})

test('aunque el CRM pida ir muy rápido, nunca baja de los mínimos seguros', () => {
    const d = normalizeDrip({ minDelay: 100, maxDelay: 200, batchSize: 1, batchPause: 1000 })
    assert.ok(d.minDelay >= 15_000, 'espera mínima')
    assert.ok(d.maxDelay >= d.minDelay)
    assert.ok(d.batchSize >= 3)
    assert.ok(d.batchPause >= 60_000)
    assert.ok(d.batchPauseMax >= d.batchPause)
})

test('respeta una cadencia razonable tal cual', () => {
    const d = normalizeDrip({ minDelay: 35_000, maxDelay: 75_000, batchSize: 18, batchPause: 180_000, batchPauseMax: 360_000 })
    assert.deepEqual(d, { minDelay: 35_000, maxDelay: 75_000, batchSize: 18, batchPause: 180_000, batchPauseMax: 360_000 })
})

test('las esperas varían y nunca bajan del mínimo; a veces hay una larga', () => {
    const d = normalizeDrip({ minDelay: 35_000, maxDelay: 75_000 })
    const waits = Array.from({ length: 3000 }, () => humanDelay(d))
    assert.ok(waits.every((w) => w >= d.minDelay), 'nunca menos que el mínimo')
    assert.ok(new Set(waits).size > 500, 'no son siempre iguales')
    assert.ok(waits.some((w) => w > d.maxDelay), 'alguna espera larga (distracción)')
    assert.ok(waits.filter((w) => w > d.maxDelay).length < 3000 * 0.2, 'pero son la excepción')
})

test('el tamaño de bloque es irregular (±25 %)', () => {
    const d = normalizeDrip({ batchSize: 20 })
    const sizes = Array.from({ length: 500 }, () => nextBatchSize(d))
    assert.ok(Math.min(...sizes) >= 15 && Math.max(...sizes) <= 25)
    assert.ok(new Set(sizes).size > 3)
})

test('franja nocturna: 22:00-08:00 de México, que cruza la medianoche', () => {
    const q = quietHoursConfig({})
    assert.deepEqual(q, { start: 22, end: 8, timeZone: 'America/Mexico_City' })
    // Ciudad de México es UTC-6 todo el año
    const at = (utcHour) => new Date(Date.UTC(2026, 9, 2, utcHour, 0, 0))
    assert.equal(isQuietTime(at(16), q), false, '10:00 México')
    assert.equal(isQuietTime(at(5), q), true, '23:00 México')
    assert.equal(isQuietTime(at(12), q), true, '06:00 México')
    assert.equal(isQuietTime(at(14), q), false, '08:00 México ya se puede enviar')
    assert.equal(isQuietTime(at(3), q), false, '21:00 México todavía se puede enviar')
})

test('la franja se puede desactivar o configurar', () => {
    assert.equal(quietHoursConfig({ BULK_QUIET_HOURS: 'off' }), null)
    assert.equal(isQuietTime(new Date(), null), false)
    assert.deepEqual(quietHoursConfig({ BULK_QUIET_HOURS: '23-7', BULK_TIMEZONE: 'America/Bogota' }), { start: 23, end: 7, timeZone: 'America/Bogota' })
    assert.equal(quietHoursConfig({ BULK_QUIET_HOURS: 'basura' }).start, 22)
})

test('spintax elige una opción por grupo', () => {
    const seen = new Set(Array.from({ length: 200 }, () => resolveSpintax('{Hola|Buenas|Qué tal} amigo')))
    assert.deepEqual([...seen].sort(), ['Buenas amigo', 'Hola amigo', 'Qué tal amigo'])
    assert.equal(resolveSpintax('sin variantes'), 'sin variantes')
})
