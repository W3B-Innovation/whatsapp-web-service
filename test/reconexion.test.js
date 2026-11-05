import test from 'node:test'
import assert from 'node:assert/strict'
import { esperaDeReconexion, ESPERAS_MS } from '../src/reconexion.js'

test('un error de red sin clasificar se reintenta con espera creciente', () => {
    assert.equal(esperaDeReconexion(500, 0), 5000)
    assert.equal(esperaDeReconexion(500, 1), 15000)
    assert.equal(esperaDeReconexion(500, 2), 30000)
})

test('la espera no pasa de cinco minutos', () => {
    assert.equal(esperaDeReconexion(500, 50), 300000)
    assert.equal(Math.max(...ESPERAS_MS), 300000)
})

test('los cortes normales y un cierre sin código también se reintentan', () => {
    for (const codigo of [428, 408, 503, undefined]) {
        assert.equal(esperaDeReconexion(codigo, 0), 5000)
    }
})

test('si WhatsApp cerró o bloqueó la sesión no se reintenta', () => {
    for (const codigo of [401, 403, 405, 411]) {
        assert.equal(esperaDeReconexion(codigo, 0), null)
    }
})

test('con otra conexión en la sesión se espera mucho y se termina rindiendo', () => {
    assert.equal(esperaDeReconexion(440, 0), 300000)
    assert.equal(esperaDeReconexion(440, 5), 300000)
    assert.equal(esperaDeReconexion(440, 6), null)
})
