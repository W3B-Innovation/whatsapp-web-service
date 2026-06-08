import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { connectToWhatsApp, getStatus, sendMessage, setStatus, getLastQr, initExistingSessions, getNumber, getGlobalStats, logout, getSocket, sessions, getGroups, getGroupInvite, resolveGroupInfo, updateSessionConfig } from './whatsappService.js'
import { fetchAndSyncHistory } from './recovery.js'
import { activeCampaigns } from './bulkService.js'

const app = express()
const PORT = process.env.PORT || 4000

app.use(express.json())

// --- Configuración de Seguridad y Orígenes ---
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['https://crm.bitend.ai', 'https://codigos.soyandrade.com', 'https://soyandrade.com'];

app.use(cors({
    origin: (origin, callback) => {
        // Permitir peticiones sin origen (como Postman, curl o llamadas server-to-server)
        if (!origin) return callback(null, true);

        const isAllowed = allowedOrigins.some(o => origin.startsWith(o)) || origin.includes('localhost');

        if (isAllowed) {
            callback(null, true);
        } else {
            console.error(`[Security] Bloqueado por CORS: Origen no permitido::: (${origin})`);
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

// Middleware para identificar y loguear el origen de cada petición en consola
app.use((req, res, next) => {
    const origin = req.headers.origin || req.headers.referer || 'Direct Access/Other';
    console.log(`[API Request] ${new Date().toLocaleTimeString()} | ${req.method} ${req.path} | Origin: ${origin}`);
    next();
});

// Middleware para normalizar accountId (solo si es necesario)
app.use((req, res, next) => {
    const normalize = (id) => {
        if (!id) return id;
        // Si la sesión existe con el ID original (ej. con prefijo), usar ese
        if (sessions[id]) return id;
        // Si no existe, intentar quitar el prefijo (compatibilidad con sesiones viejas)
        const stripped = id.replace('SOYANDRADE_', '');
        if (sessions[stripped]) return stripped;
        return id;
    };

    if (req.query.accountId) {
        req.query.accountId = normalize(req.query.accountId);
    }
    if (req.body && req.body.accountId) {
        req.body.accountId = normalize(req.body.accountId);
    }
    next();
});

// --- API Endpoints ---

// Listar todas las sesiones y su configuración sugerida
app.get('/sessions', (req, res) => {
    const sessionIds = Object.keys(sessions)
    const results = sessionIds.map(id => {
        return {
            id,
            status: getStatus(id),
            hasQr: !!getLastQr(id),
            number: getNumber(id),
            origin: sessions[id]?.origin || null,
            companyId: sessions[id]?.companyId || null,
            activeGroupId: sessions[id]?.activeGroupId || null,
            activeGroupName: sessions[id]?.activeGroupName || null
        }
    })
    res.json(results)
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
        pairingCode: sessions[accountId]?.lastPairingCode || null,
        number: getNumber(accountId),
        origin: sessions[accountId]?.origin || null,
        companyId: sessions[accountId]?.companyId || null,
        activeGroupId: sessions[accountId]?.activeGroupId || null,
        activeGroupName: sessions[accountId]?.activeGroupName || null,
        duplicateConflictId: sessions[accountId]?.duplicateConflictId || null,
        duplicateConflictOrigin: sessions[accountId]?.duplicateConflictOrigin || null
    })
})

// Actualizar configuración de una sesión
app.post('/update-config', (req, res) => {
    const { accountId, companyId, origin, activeGroupId, activeGroupName } = req.body
    if (!accountId) return res.status(400).json({ error: 'accountId es requerido' })

    const success = updateSessionConfig(accountId, { companyId, origin, activeGroupId, activeGroupName })
    if (success) {
        res.json({ success: true, message: `Configuración de ${accountId} actualizada.` })
    } else {
        res.status(404).json({ error: `Sesión ${accountId} no encontrada.` })
    }
})

// Obtener lista de grupos de una cuenta
app.get('/groups', async (req, res) => {
    const accountId = req.query.accountId || 'account-1'
    try {
        const groups = await getGroups(accountId)
        res.json(groups)
    } catch (error) {
        console.error(`[${accountId}] Error en /groups:`, error.message)
        const status = getStatus(accountId)
        if (status !== 'open') {
            return res.status(503).json({ error: `WhatsApp (${accountId}) no está conectado.` })
        }
        res.status(500).json({ error: 'Error al obtener grupos' })
    }
})

// Obtener link de invitación de un grupo
app.get('/group-invite', async (req, res) => {
    const { accountId = 'account-1', groupId } = req.query
    if (!groupId) return res.status(400).json({ error: 'groupId es requerido' })

    try {
        const link = await getGroupInvite(accountId, groupId)
        res.json({ link })
    } catch (error) {
        console.error(`[${accountId}] Error en /group-invite:`, error.message)
        res.status(500).json({ error: 'Error al obtener link del grupo' })
    }
})

// Resolver información de grupo desde cualquier link (soporta Sendflow)
app.get('/resolve-group', async (req, res) => {
    const { accountId = 'account-1', url } = req.query
    if (!url) return res.status(400).json({ error: 'url es requerida' })

    try {
        const info = await resolveGroupInfo(accountId, url)
        res.json(info)
    } catch (error) {
        console.error(`[${accountId}] Error en /resolve-group:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

// Iniciar conexión manualmente para una cuenta específica
app.post('/connect', async (req, res) => {
    let { accountId = 'account-1', companyId, browserName, phoneNumber } = req.body
    const origin = req.headers.origin || req.headers.referer || 'Direct Access/Other';

    // Adaptar el nombre del navegador (lo que aparece en el celular) según el origen
    if (!browserName) {
        if (origin.includes('bitend.ai')) {
            browserName = 'Bitend AI CRM';
        } else if (origin.includes('soyandrade.com')) {
            browserName = 'Soy Andrade CRM';
        } else {
            browserName = 'WhatsApp Sync Service';
        }
    }

    const status = getStatus(accountId)

    if (status === 'open') {
        return res.json({ message: `La cuenta ${accountId} ya está conectada`, status })
    }

    if (status === 'connecting' || status === 'qr_ready' || status === 'pairing_code_ready') {
        return res.json({ message: `La conexión para ${accountId} ya está en proceso`, status })
    }

    connectToWhatsApp(accountId, companyId, browserName, origin, null, null, phoneNumber).catch(err => {
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
    const { accountId = 'account-1', number, message, media } = req.body

    if (!number || (!message && !media)) {
        return res.status(400).json({ error: 'Faltan parámetros: number y (message o media)' })
    }

    try {
        const result = await sendMessage(accountId, number, message, media)
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

// Nuevo endpoint para envíos masivos (procesamiento en fondo real)
app.post('/bulk-send', async (req, res) => {
    const { accountId, companyId, message, contacts, bulkMessageId, customTemplate, webhookUrl } = req.body

    if (!accountId || !message || !contacts || !bulkMessageId) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos para el envío masivo' })
    }

    // Importación dinámica para evitar circular dependency si la hubiera
    const { processBulkSend } = await import('./bulkService.js')

    // Lanzar en fondo y responder inmediatamente
    processBulkSend({
        accountId,
        companyId,
        message,
        contacts,
        bulkMessageId,
        customTemplate,
        webhookUrl
    }).catch(err => {
        console.error(`[Bulk Error] Fatal en proceso de fondo para ${bulkMessageId}:`, err.message)
    })

    res.json({
        success: true,
        message: 'Proceso de envío masivo iniciado en segundo plano.',
        bulkMessageId
    })
})

// Endpoint para pausar envío masivo
app.post('/bulk-send/pause', (req, res) => {
    const { bulkMessageId } = req.body
    if (!bulkMessageId) return res.status(400).json({ error: 'bulkMessageId es requerido' })

    const campaign = activeCampaigns.get(bulkMessageId)
    if (campaign) {
        campaign.paused = true
        console.log(`[Bulk Control] Solicitud de pausa recibida para campaña: ${bulkMessageId}`)
        return res.json({ success: true, message: `Pausa solicitada para campaña ${bulkMessageId}.` })
    }
    res.status(404).json({ error: 'Campaña no activa en este microservicio.' })
})

// Endpoint para cancelar envío masivo
app.post('/bulk-send/cancel', (req, res) => {
    const { bulkMessageId } = req.body
    if (!bulkMessageId) return res.status(400).json({ error: 'bulkMessageId es requerido' })

    const campaign = activeCampaigns.get(bulkMessageId)
    if (campaign) {
        campaign.cancelled = true
        console.log(`[Bulk Control] Solicitud de cancelación recibida para campaña: ${bulkMessageId}`)
        return res.json({ success: true, message: `Cancelación solicitada para campaña ${bulkMessageId}.` })
    }
    res.status(404).json({ error: 'Campaña no activa en este microservicio.' })
})

// Recuperar historial de un chat específico
/** 
 * ENDPOINT DESACTIVADO - Ya no se usa la recuperación de historial
app.post('/fetch-history', async (req, res) => {
    const { accountId = 'account-1', number, count = 50 } = req.body

    console.log(`[API:FetchHistory] Recibida solicitud para ${number} (Cuenta: ${accountId}, Cantidad: ${count})`)

    if (!number) {
        return res.status(400).json({ error: 'Faltan parámetros: number es requerido' })
    }

    const sock = getSocket(accountId)
    if (!sock) {
        return res.status(503).json({ error: `La cuenta ${accountId} no está conectada.` })
    }

    const ownNumber = sock.user?.id?.split(':')[0] || 'desconocido'
    console.log(`[API:FetchHistory] Usando cuenta ${accountId} (Propia: ${ownNumber}) para recuperar ${number}`)

    try {
        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`
        const companyId = sessions[accountId]?.companyId || null

        const result = await fetchAndSyncHistory(sock, accountId, companyId, jid, count)
        res.json(result)
    } catch (error) {
        console.error(`[${accountId}] Error en /fetch-history:`, error.message)
        res.status(500).json({ error: error.message })
    }
})
*/

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
