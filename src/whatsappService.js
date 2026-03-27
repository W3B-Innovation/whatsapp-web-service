import { DisconnectReason, makeWASocket, useMultiFileAuthState, downloadMediaMessage, fetchLatestWaWebVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import fetch from 'node-fetch'


const sessions = {}
const instanceId = Math.random().toString(36).substring(7)
const sessionSuffix = Date.now().toString().slice(-4)
const SESSIONS_FILE = './sessions.json'
console.log(`[System] Instancia: ${instanceId} | Sufijo: ${sessionSuffix}`)

// Cargar sesiones persistentes (solo metadata como companyId)
function loadPersistentSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
            for (const id in data) {
                if (!sessions[id]) {
                    sessions[id] = { 
                        sock: null, 
                        connectionStatus: 'disconnected', 
                        lastQr: null, 
                        contactNamesByJid: {}, 
                        contactLids: {},
                        ...data[id] 
                    }
                } else {
                    Object.assign(sessions[id], data[id])
                }
            }
            console.log(`[System] ${Object.keys(data).length} sesiones cargadas desde disco.`)
        }
    } catch (e) {
        console.error('[System] Error cargando sesiones persistentes:', e.message)
    }
}

function savePersistentSessions() {
    try {
        const metadata = {}
        for (const id in sessions) {
            metadata[id] = {
                companyId: sessions[id].companyId,
                number: sessions[id].number
            }
        }
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(metadata, null, 2))
    } catch (e) {
        console.error('[System] Error guardando sesiones persistentes:', e.message)
    }
}

loadPersistentSessions()

const globalStats = {
    messagesReceived: 0,
    messagesSent: 0,
    webhookSuccess: 0,
    webhookErrors: 0,
    startTime: Date.now()
}

// Contadores por empresa (companyId -> counters)
const companyStats = {}

export function getGlobalStats(companyId = null) {
    if (companyId) {
        // Filtrar sesiones que pertenecen a esta empresa
        const companySessions = Object.values(sessions).filter(s => s.companyId === companyId)
        const cs = companyStats[companyId] || { messagesReceived: 0, messagesSent: 0, webhookSuccess: 0, webhookErrors: 0 }
        return {
            messagesReceived: cs.messagesReceived,
            messagesSent: cs.messagesSent,
            webhookSuccess: cs.webhookSuccess,
            webhookErrors: cs.webhookErrors,
            startTime: globalStats.startTime,
            activeSessions: companySessions.filter(s => s.connectionStatus === 'open').length,
            totalSessions: companySessions.length
        }
    }
    return {
        ...globalStats,
        activeSessions: Object.keys(sessions).filter(id => sessions[id].connectionStatus === 'open').length,
        totalSessions: Object.keys(sessions).length
    }
}

export async function connectToWhatsApp(accountId = 'default', companyId = null) {
    // Inicializar sesión si no existe
    if (!sessions[accountId]) {
        sessions[accountId] = {
            sock: null,
            connectionStatus: 'disconnected',
            lastQr: null,
            companyId: companyId,
            contactNamesByJid: {}, // Caché: JID -> nombre del contacto
            contactLids: {},
        }
    }
    
    // SIEMPRE actualizar companyId si se provee, para no perderlo en reconexiones
    if (companyId) {
        sessions[accountId].companyId = companyId
        savePersistentSessions()
    }
    
    if (!sessions[accountId].contactNamesByJid) sessions[accountId].contactNamesByJid = {}
    if (!sessions[accountId].contactLids) sessions[accountId].contactLids = {}

    // Bloquear si ya hay una conexión activa o en progreso
    const currentStatus = sessions[accountId].connectionStatus
    if (currentStatus === 'open' || currentStatus === 'connecting' || currentStatus === 'qr_ready') {
        console.log(`[${accountId}] Bloqueando: ya hay una conexión en estado '${currentStatus}'.`)
        return
    }

    sessions[accountId].connectionStatus = 'connecting'
    console.log(`[${accountId}] [MANUAL] Iniciando conexión...`)

    // Limpieza de carpetas corruptas (sin creds.json)
    const authFolder = `auth_baileys_${accountId}`
    if (fs.existsSync(authFolder) && !fs.existsSync(`${authFolder}/creds.json`)) {
        console.log(`[${accountId}] Limpiando auth folder corrupto...`)
        try { fs.rmSync(authFolder, { recursive: true, force: true }) } catch (e) { }
    }

    // Limpiar socket previo en memoria
    if (sessions[accountId].sock) {
        try {
            sessions[accountId].sock.ev.removeAllListeners()
            if (sessions[accountId].sock.ws) sessions[accountId].sock.ws.close()
        } catch (e) { }
        sessions[accountId].sock = null
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder)

    // Obtener la versión actual de WhatsApp Web
    // Esto resuelve el error 405 causado por la versión hardcodeada en Baileys
    const { version, isLatest } = await fetchLatestWaWebVersion()
    console.log(`[${accountId}] Versión WA: ${version.join('.')} (isLatest: ${isLatest})`)

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Bitend AI CRM', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        linkPreviewImageThumbnailWidth: 192,
        shouldSyncHistoryMessage: () => false
    })

    sessions[accountId].sock = sock
    if (!sessions[accountId].contactNamesByJid) sessions[accountId].contactNamesByJid = {}
    if (!sessions[accountId].contactLids) sessions[accountId].contactLids = {}
    sock.ev.on('creds.update', saveCreds)

    // Poblar caché de nombres desde la agenda del dispositivo vinculado
    // Esto permite resolver el nombre del contacto en mensajes salientes
    function mergeContactNames(contactList) {
        if (!Array.isArray(contactList)) return
        const map = sessions[accountId].contactNamesByJid
        const mapLids = sessions[accountId].contactLids
        
        for (const c of contactList) {
            const jid = c.id || ''
            const name = (c.name && String(c.name).trim()) || (c.notify && String(c.notify).trim()) || ''
            
            if (name && jid) {
                map[jid] = name
                const rawNum = jid.split('@')[0].split(':')[0]
                if (rawNum && /^\d+$/.test(rawNum) && !jid.includes('@lid')) {
                    map[`${rawNum}@s.whatsapp.net`] = name
                }
            }

            // Capturar mapeo LID -> Real Phone
            const lid = c.lid ? String(c.lid).split('@')[0] : (jid.includes('@lid') ? jid.split('@')[0] : null)
            const realPhone = !jid.includes('@lid') ? jid.split('@')[0].split(':')[0] : null
            
            if (lid && realPhone && /^\d+$/.test(realPhone)) {
                mapLids[lid] = realPhone
                console.log(`[${accountId}] 🔗 LID MAPPING: ${lid} -> ${realPhone} (via contact update)`)
            }
        }
    }
    sock.ev.on('contacts.upsert', mergeContactNames)
    sock.ev.on('contacts.update', mergeContactNames)
    sock.ev.on('messaging-history.set', ({ contacts }) => {
        if (contacts && contacts.length > 0) {
            console.log(`[${accountId}] 📥 Sincronizando ${contacts.length} contactos desde historial...`)
            mergeContactNames(contacts)
        }
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            sessions[accountId].connectionStatus = 'qr_ready'
            sessions[accountId].lastQr = qr
            console.log(`[${accountId}] QR listo — disponible para el CRM via /status`)
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            console.log(`[${accountId}] Conexión cerrada. Código: ${statusCode}`)

            sessions[accountId].sock = null
            sessions[accountId].number = null
            sessions[accountId].lastQr = null

            if (statusCode === DisconnectReason.restartRequired) {
                // Flujo normal tras escanear el QR: WA desconecta para entregar las creds.
                // Reseteamos el status primero para que el guard del singleton no lo bloquee.
                console.log(`[${accountId}] restartRequired → reconectando para obtener credenciales...`)
                sessions[accountId].connectionStatus = 'disconnected'
                connectToWhatsApp(accountId, sessions[accountId]?.companyId)

            } else if (statusCode === DisconnectReason.connectionClosed || statusCode === DisconnectReason.connectionLost) {
                // 428 (connectionClosed) / 408 (connectionLost / timedOut):
                // Los servidores de WA cerraron el WebSocket temporalmente (keepalive, rolling restart, etc.)
                // La sesión y las credenciales son válidas → reconectar automáticamente con backoff
                console.log(`[${accountId}] connectionClosed/Lost (${statusCode}) → reconectando en 3s...`)
                sessions[accountId].connectionStatus = 'disconnected'
                setTimeout(() => {
                    connectToWhatsApp(accountId, sessions[accountId]?.companyId)
                }, 3000)

            } else if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.multideviceMismatch) {
                // Logout formal o conflicto multi-device: limpiar creds y esperar acción manual
                console.log(`[${accountId}] Sesión cerrada/desvinculada. Limpiando datos y esperando acción manual.`)
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true })
                sessions[accountId].connectionStatus = 'disconnected'

            } else if (statusCode === 405) {
                // 405: WA rechazó la conexión. NO reintentar automáticamente.
                console.error(`[${accountId}] ❌ 405: WhatsApp rechazó la conexión.`)
                console.error(`[${accountId}] Usa el botón 'Enlazar Cuenta' desde el CRM para reintentar manualmente.`)
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true })
                sessions[accountId].connectionStatus = 'disconnected'

            } else if (statusCode === DisconnectReason.unavailableService) {
                // 503 (unavailableService): servidor de WA temporalmente no disponible
                // (sobrecarga, rolling restart, etc.) → reconectar con backoff mayor
                console.log(`[${accountId}] unavailableService (503) → reconectando en 5s...`)
                sessions[accountId].connectionStatus = 'disconnected'
                setTimeout(() => {
                    connectToWhatsApp(accountId, sessions[accountId]?.companyId)
                }, 5000)

            } else {
                // Cualquier otro error desconocido: desconectado, sin reintento automático
                console.log(`[${accountId}] Desconectado por código ${statusCode}. Acción manual requerida.`)
                sessions[accountId].connectionStatus = 'disconnected'
            }

        } else if (connection === 'open') {
            const userJid = sock.user?.id || ''
            const cleanNumber = userJid.split(':')[0].split('@')[0]
            sessions[accountId].connectionStatus = 'open'
            sessions[accountId].lastQr = null
            sessions[accountId].number = cleanNumber
            savePersistentSessions()
            console.log(`[${accountId}] ✅ ¡Conectado exitosamente! Número: ${cleanNumber}`)
        }
    })

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async (upsert) => {
        handleMessages(accountId, upsert)
    })

    // Escuchar actualizaciones de estado (entregado, leído, etc.)
    sock.ev.on('messages.update', async (updates) => {
        handleMessageUpdates(accountId, updates)
    })

    return sock
}

/**
 * Maneja las actualizaciones de estado de los mensajes (entregado, leído, etc.)
 */
export async function handleMessageUpdates(accountId, updates) {
    for (const update of updates) {
        if (!update.update.status) continue // Solo nos interesan cambios de estado

        const messageId = update.key.id
        let remoteJid = update.key.remoteJid
        const status = update.update.status // 1: pendiente, 2: enviado, 3: entregado, 4: leído, 5: error

        // Translate LID to real number if available in memory mapping
        let cleanNumber = remoteJid ? remoteJid.split('@')[0].split(':')[0] : 'Desconocido'
        const isLid = remoteJid && remoteJid.includes('@lid')
        
        if (isLid) {
            const rawLid = remoteJid.split('@')[0]
            const realPhone = sessions[accountId]?.contactLids?.[rawLid]
            if (realPhone) {
                cleanNumber = realPhone
                remoteJid = `${realPhone}@s.whatsapp.net` // Forzar transmutación
            }
        }

        // Mapear el estado numérico de Baileys a strings descriptivos
        const statusMap = {
            1: 'pending',
            2: 'sent',
            3: 'delivered',
            4: 'read',
            5: 'error'
        }

        const statusString = statusMap[status] || 'unknown'

        console.log(`[${accountId}] Actualización de estado: ${messageId} -> ${statusString}`)

        // Enviar al CRM vía Webhook
        const webhookUrl = process.env.CRM_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-sync/webhook'
        const companyId = sessions[accountId]?.companyId || null;

        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'status_update',
                    accountId,
                    companyId,
                    messageId,
                    status: statusString,
                    remoteJid,
                    cleanNumber,
                    timestamp: Date.now() / 1000
                })
            })
        } catch (err) {
            console.error(`[${accountId}] Error enviando update al webhook:`, err.message)
        }
    }
}



// Caché temporal de fotos de perfil (JID -> {url, timestamp})
const profilePicCache = new Map()
const CACHE_TTL = 1000 * 60 * 60 * 24 // 24 horas

async function getProfilePic(accountId, jid) {
    const now = Date.now()
    if (profilePicCache.has(jid)) {
        const cached = profilePicCache.get(jid)
        if (now - cached.timestamp < CACHE_TTL) return cached.url
    }

    try {
        const sock = sessions[accountId]?.sock
        if (!sock) return null
        const url = await sock.profilePictureUrl(jid, 'image')
        profilePicCache.set(jid, { url, timestamp: now })
        return url
    } catch (err) {
        // WhatsApp lanza error si no hay foto o por privacidad
        // Guardamos null para no reintentar constantemente en esta sesión
        profilePicCache.set(jid, { url: null, timestamp: now })
        return null
    }
}

/**
 * Función independiente para procesar mensajes entrantes y salientes
 */
export async function handleMessages(accountId, { messages, type }) {
    if (type !== 'notify') return

    for (const msg of messages) {
        const fromMe = msg.key.fromMe
        let remoteJid = msg.key.remoteJid
        const participant = msg.key.participant // Solo presente en grupos

        // Ignorar estados de WhatsApp (status@broadcast)
        if (remoteJid === 'status@broadcast') continue

        // Ignorar mensajes de grupos o listas de difusión (solo queremos chats personales)
        // remoteJid para grupos suele ser [id]@g.us
        if (remoteJid && (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@v.us') || participant)) {
            continue
        }

        // 1. DETERMINAR LA OTRA PARTE (The actual contact)
        // En WA, el remoteJid de un chat individual SIEMPRE es el otro contacto,
        // INCLUSO si el mensaje es fromMe: true.
        // PEEEERO, si mandas un mensaje A TI MISMO, remoteJid == tu numero.
        const myJid = sessions[accountId]?.sock?.user?.id?.split(':')[0] + '@s.whatsapp.net'
        const isSelfChat = remoteJid === myJid

        // Translate LID to real number if available
        let cleanNumber = remoteJid ? remoteJid.split('@')[0].split(':')[0] : 'Desconocido'
        const isLid = remoteJid && remoteJid.includes('@lid')
        
        if (isLid) {
            const rawLid = remoteJid.split('@')[0]
            const realPhone = sessions[accountId]?.contactLids?.[rawLid]
            if (realPhone) {
                console.log(`[${accountId}] 💥 RESOLUCIÓN LID EXITOSA (${fromMe ? 'Saliente' : 'Entrante'}): ${rawLid} -> ${realPhone}`)
                cleanNumber = realPhone
                remoteJid = `${realPhone}@s.whatsapp.net` // Forzar transmutación
            }
        }

        // Si es un chat contigo mismo o el microservicio se perdió, ignorar para evitar duplicados infinitos
        if (isSelfChat && fromMe) {
            console.warn(`[${accountId}] Ignorando mensaje saliente a uno mismo para evitar bucle/duplicado.`)
            continue
        }

        // Obtener foto de perfil (async, pero no bloqueante para el flujo principal si falla)
        const profilePicUrl = await getProfilePic(accountId, remoteJid)

        // Detectar si es un mensaje con media
        const messageType = Object.keys(msg.message || {})[0] || 'unknown'
        const hasMedia = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(messageType)

        let mediaBase64 = null
        let mimetype = null
        let fileName = null

        if (hasMedia) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: sessions[accountId].sock.updateMediaMessage
                })
                mediaBase64 = buffer.toString('base64')
                mimetype = msg.message[messageType].mimetype
                fileName = msg.message[messageType].fileName || null
            } catch (err) {
                console.error(`[${accountId}] Error descargando media:`, err.message)
            }
        }

        const text = msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            ""

        const direction = fromMe ? '📤 Mensaje saliente a' : '📩 Mensaje entrante de'

        if (text || msg.message) {
            console.log(`[${accountId}] ${direction} ${cleanNumber}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`)

            // Incrementar contadores de mensajes (global + por empresa)
            if (fromMe) globalStats.messagesSent++
            else globalStats.messagesReceived++

            const cId = sessions[accountId]?.companyId
            if (cId) {
                if (!companyStats[cId]) companyStats[cId] = { messagesReceived: 0, messagesSent: 0, webhookSuccess: 0, webhookErrors: 0 }
                if (fromMe) companyStats[cId].messagesSent++
                else companyStats[cId].messagesReceived++
            }

            // Enviar al CRM vía Webhook
            const webhookUrl = process.env.CRM_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-sync/webhook'
            const companyId = sessions[accountId]?.companyId || null;

            try {
                const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        accountId,
                        companyId,
                        fromMe,
                        remoteJid,
                        cleanNumber,
                        text,
                        timestamp: msg.messageTimestamp,
                        pushName: (() => {
                            const map = sessions[accountId]?.contactNamesByJid || {}
                            
                            // Siempre intentar sacar el nombre del caché usando el JID del OTRO (destinatario/remitente)
                            const cachedName = map[remoteJid] || map[`${cleanNumber}@s.whatsapp.net`]
                            
                            if (!fromMe) {
                                // Entrante: El mensaje trae el pushName del que envía (el contacto)
                                const inboundName = msg.pushName && String(msg.pushName).trim()
                                if (inboundName) {
                                    map[remoteJid] = inboundName
                                    map[`${cleanNumber}@s.whatsapp.net`] = inboundName
                                    return inboundName
                                }
                                return cachedName || null
                            } else {
                                // Saliente: El pushName en el mensaje eres TÚ. 
                                // DEBEMOS ignorarlo y usar el nombre del destinatario que tengamos en caché.
                                return cachedName || null
                            }
                        })(),
                        messageId: msg.key.id,
                        media: hasMedia ? {
                            type: messageType,
                            mimetype,
                            fileName,
                            base64: mediaBase64
                        } : null
                    })
                })

                if (!response.ok) {
                    globalStats.webhookErrors++
                    if (companyId && companyStats[companyId]) companyStats[companyId].webhookErrors++
                    const errorBody = await response.text().catch(() => 'No body');
                    console.error(`[${accountId}] Error enviando al webhook (${response.status}): ${errorBody}`)
                } else {
                    globalStats.webhookSuccess++
                    if (companyId && companyStats[companyId]) companyStats[companyId].webhookSuccess++
                }
            } catch (err) {
                globalStats.webhookErrors++
                console.error(`[${accountId}] Error de conexión con el webhook:`, err.message)
            }
        }
    }
}

export function getSocket(accountId = 'default') {
    return sessions[accountId]?.sock || null
}

export function setStatus(accountId = 'default', status) {
    if (!sessions[accountId]) {
        sessions[accountId] = { sock: null, connectionStatus: status, lastQr: null, contactNamesByJid: {}, contactLids: {} }
    } else {
        sessions[accountId].connectionStatus = status
    }
}

export function getStatus(accountId = 'default') {
    return sessions[accountId]?.connectionStatus || 'disconnected'
}

export function getLastQr(accountId = 'default') {
    return sessions[accountId]?.lastQr || null
}

export function getNumber(accountId = 'default') {
    return sessions[accountId]?.number || null
}

export async function sendMessage(accountId = 'default', number, message) {
    const session = sessions[accountId]
    if (!session || !session.sock || session.connectionStatus !== 'open') {
        throw new Error(`WhatsApp no está conectado para la cuenta ${accountId}`)
    }

    // Si el número es largo y no tiene @, probablemente sea un LID
    let jid = number.includes('@') ? number : `${number}@s.whatsapp.net`
    if (!number.includes('@') && number.length >= 15 && !number.startsWith('521')) { // Regla heurística para LIDs
        jid = `${number}@lid`
    }
    
    console.log(`[${accountId}] Enviando a JID resolved: ${jid}`)
    return await session.sock.sendMessage(jid, { text: message })
}

export async function logout(accountId = 'default') {
    if (!sessions[accountId]) return

    console.log(`[${accountId}] Solicitud de cierre de sesión/cancelación...`)

    if (sessions[accountId].sock) {
        try {
            // Intentar logout formal si está abierto
            if (sessions[accountId].connectionStatus === 'open') {
                await sessions[accountId].sock.logout()
            } else {
                // Si solo estaba conectando/QR, forzamos cierre
                sessions[accountId].sock.ev.removeAllListeners()
            }
        } catch (e) {
            console.error(`[${accountId}] Error durante logout:`, e.message)
        }
    }

    // Limpiar estado local
    delete sessions[accountId]

    // Limpiar carpeta de auth si no está conectado (cancelación de vinculación)
    const authFolder = `auth_baileys_${accountId}`
    if (fs.existsSync(authFolder)) {
        try {
            fs.rmSync(authFolder, { recursive: true, force: true })
            console.log(`[${accountId}] Datos de sesión eliminados.`)
        } catch (e) {
            console.error(`[${accountId}] Error eliminando carpeta de auth:`, e.message)
        }
    }
}

// Inicializar sesiones existentes al arrancar
export async function initExistingSessions() {
    const files = fs.readdirSync('.')
    const authFolders = files.filter(f => f.startsWith('auth_baileys_'))

    for (const folder of authFolders) {
        const accountId = folder.replace('auth_baileys_', '')
        // Solo restaurar si el archivo de credenciales existe
        if (fs.existsSync(`${folder}/creds.json`)) {
            // Extraer companyId del accountId (formato: {companyId}-slot-{n})
            // Es crítico pasarlo para que los contadores por empresa funcionen desde el arranque
            const slotMatch = accountId.match(/^(.+)-slot-\d+$/)
            const companyId = slotMatch ? slotMatch[1] : null
            if (companyId) {
                console.log(`Restaurando sesión para: ${accountId} (empresa: ${companyId})`)
            } else {
                console.log(`Restaurando sesión para: ${accountId}`)
            }
            connectToWhatsApp(accountId, companyId).catch(err => console.error(`Error restaurando ${accountId}:`, err))
        } else {
            console.log(`Saltando carpeta vacía o corrupta: ${folder}`)
        }
    }
}


