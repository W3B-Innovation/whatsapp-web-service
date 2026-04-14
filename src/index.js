import 'dotenv/config'
import express from 'express'
import { connectToWhatsApp, getStatus, sendMessage, setStatus, getLastQr, initExistingSessions, getNumber, getGlobalStats, logout, getSocket } from './whatsappService.js'

const app = express()
const PORT = process.env.PORT || 4000

app.use(express.json())

// --- API Endpoints ---

// Listar todas las sesiones y su configuración sugerida
app.get('/sessions', (req, res) => {
    const slots = [1, 2, 3, 4, 5].map(id => {
        const accountId = `account-${id}`
        return {
            id: accountId,
            status: getStatus(accountId),
            hasQr: !!getLastQr(accountId),
            number: getNumber(accountId)
        }
    })
    res.json(slots)
})

// Nuevo endpoint para monitorear el consumo de recursos
// Acepta ?companyId= para filtrar stats por empresa
app.get('/stats', (req, res) => {
    const companyId = req.query.companyId || null
    const memory = process.memoryUsage()
    const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB'
    const operationalStats = getGlobalStats(companyId)

    res.json({
        ...operationalStats,
        memory: {
            rss: toMB(memory.rss),           // RAM total asignada al proceso
            heapTotal: toMB(memory.heapTotal), // RAM total reservada para objetos
            heapUsed: toMB(memory.heapUsed),   // RAM realmente usada por objetos
            external: toMB(memory.external)    // Memoria usada por buffers de C++ (Baileys usa esto)
        },
        uptime_seconds: Math.floor(process.uptime())
    })
})

// Ver estado de una cuenta específica (por defecto 'account-1')
app.get('/status', (req, res) => {
    const accountId = req.query.accountId || 'account-1'
    res.json({
        accountId,
        status: getStatus(accountId),
        qr: getLastQr(accountId),
        number: getNumber(accountId)
    })
})

// Iniciar conexión manualmente para una cuenta específica
app.post('/connect', async (req, res) => {
    const { accountId = 'account-1', companyId, browserName } = req.body
    const status = getStatus(accountId)

    if (status === 'open') {
        return res.json({ message: `La cuenta ${accountId} ya está conectada`, status })
    }

    if (status === 'connecting' || status === 'qr_ready') {
        return res.json({ message: `La conexión para ${accountId} ya está en proceso`, status })
    }

    connectToWhatsApp(accountId, companyId, browserName).catch(err => {
        console.error(`Error al conectar ${accountId}:`, err)
        setStatus(accountId, 'disconnected')
    })

    res.json({ message: `Iniciando proceso para ${accountId}...`, status: 'connecting' })
})

// Cerrar sesión o cancelar vinculación
app.post('/logout', async (req, res) => {
    const { accountId = 'account-1' } = req.body
    try {
        await logout(accountId)
        res.json({ success: true, message: `Sesión ${accountId} cerrada/cancelada.` })
    } catch (error) {
        console.error(`[${accountId}] Error en endpoint logout:`, error.message)
        res.status(500).json({ error: 'Error al cerrar sesión' })
    }
})

// Enviar un mensaje usando una cuenta específica
app.post('/send-message', async (req, res) => {
    const { accountId = 'account-1', number, message } = req.body

    if (!number || !message) {
        return res.status(400).json({ error: 'Faltan parámetros: number y message' })
    }

    try {
        const result = await sendMessage(accountId, number, message)
        res.json({ success: true, result })
    } catch (error) {
        console.error(`[${accountId}] Error al enviar mensaje:`, error.message)
        const status = getStatus(accountId)

        if (status !== 'open') {
            return res.status(503).json({ error: `WhatsApp (${accountId}) no está conectado.` })
        }

        res.status(500).json({ error: 'Error al enviar mensaje' })
    }
})

// [TEST ONLY] Simula un cierre de WebSocket para probar la reconexión automática (428)
app.post('/test-disconnect', (req, res) => {
    const { accountId = 'account-1' } = req.body
    const sock = getSocket(accountId)
    if (!sock) {
        return res.status(404).json({ error: `No hay socket activo para ${accountId}` })
    }
    console.log(`[TEST] Forzando cierre de WebSocket para ${accountId} (simula código 428)...`)
    try {
        sock.ws.close() // Cierra el WebSocket → Baileys emite connectionClosed (428)
        res.json({ success: true, message: `WebSocket de ${accountId} cerrado. Observa los logs para ver la reconexión automática.` })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.listen(PORT, async () => {
    console.log(`Servidor API ejecutándose en http://localhost:${PORT}`)
    console.log('Restaurando sesiones previas...')
    await initExistingSessions()
    console.log('Servicio listo.')
})
