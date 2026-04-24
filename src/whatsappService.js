import { DisconnectReason, makeWASocket, useMultiFileAuthState, downloadMediaMessage, fetchLatestWaWebVersion, isPnUser } from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import fetch from 'node-fetch'


export const sessions = {}
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

/**
 * Función centralizada para enviar mensajes al CRM
 */
async function sendToWebhook(accountId, msg, isHistory = false) {
    const session = sessions[accountId]
    if (!session || !session.sock) return

    const { remoteJid, fromMe, participant } = msg.key
    const rawNum = remoteJid.split('@')[0].split(':')[0]
    
    // 1. RESOLVER JID Y LID (Baileys v7)
    let targetJid = remoteJid
    let originalLid = null
    const isLidIdentity = remoteJid.includes('@lid')
    
    if (isLidIdentity) {
        originalLid = rawNum
        const mapped = session.contactLids[originalLid]
        if (mapped) {
            targetJid = `${mapped}@s.whatsapp.net`
        }
    }

    // 2. FILTRAR GRUPOS Y BROADCASTS
    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || participant) {
        return
    }

    const myJid = session.sock.user?.id?.split(':')[0] + '@s.whatsapp.net'
    const isSelfChat = remoteJid === myJid
    const finalCleanNumber = targetJid.split('@')[0].split(':')[0]

    if (isSelfChat && fromMe) return

    // 3. MEDIA Y TEXTO
    const messageType = Object.keys(msg.message || {})[0] || 'unknown'
    const hasMedia = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(messageType)

    let mediaBase64 = null
    let mimetype = null
    let fileName = null

    if (hasMedia) {
        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                logger: pino({ level: 'silent' }),
                reuploadRequest: session.sock.updateMediaMessage
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

    if (text || msg.message) {
        // Incrementar contadores
        if (fromMe) globalStats.messagesSent++
        else globalStats.messagesReceived++

        const cId = session.companyId
        if (cId) {
            if (!companyStats[cId]) companyStats[cId] = { messagesReceived: 0, messagesSent: 0, webhookSuccess: 0, webhookErrors: 0 }
            if (fromMe) companyStats[cId].messagesSent++
            else companyStats[cId].messagesReceived++
        }

        const webhookUrl = process.env.CRM_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-sync/webhook'
        
        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accountId,
                    companyId: session.companyId || null,
                    fromMe,
                    remoteJid,
                    cleanNumber: finalCleanNumber,
                    text,
                    isHistory,
                    timestamp: msg.messageTimestamp,
                    pushName: (() => {
                        const map = session.contactNamesByJid || {}
                        const cachedName = map[remoteJid] || map[`${finalCleanNumber}@s.whatsapp.net`]
                        if (!fromMe) {
                            const inboundName = msg.pushName && String(msg.pushName).trim()
                            if (inboundName) {
                                map[remoteJid] = inboundName
                                map[`${finalCleanNumber}@s.whatsapp.net`] = inboundName
                                return inboundName
                            }
                            return cachedName || null
                        }
                        return cachedName || null
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
                if (cId && companyStats[cId]) companyStats[cId].webhookErrors++
                const errorBody = await response.text().catch(() => 'No body');
                console.error(`[${accountId}] Error webhook (${response.status}): ${errorBody}`)
            } else {
                globalStats.webhookSuccess++
                if (cId && companyStats[cId]) companyStats[cId].webhookSuccess++
            }
        } catch (err) {
            globalStats.webhookErrors++
            console.error(`[${accountId}] Error de conexión webhook:`, err.message)
        }
    }
}

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

export async function connectToWhatsApp(accountId = 'default', companyId = null, browserName = 'Bitend AI CRM') {
    // Inicializar sesión si no existe
    if (!sessions[accountId]) {
        sessions[accountId] = {
            sock: null,
            connectionStatus: 'disconnected',
            lastQr: null,
            companyId: companyId,
            browserName: browserName, // Guardar preferencia de nombre
            contactNamesByJid: {}, // Caché: JID -> nombre del contacto
            contactLids: {},
        }
    }

    // SIEMPRE actualizar companyId y browserName si se proveen
    if (companyId) sessions[accountId].companyId = companyId
    if (browserName) sessions[accountId].browserName = browserName
    
    savePersistentSessions()

    if (!sessions[accountId].contactNamesByJid) sessions[accountId].contactNamesByJid = {}
    if (!sessions[accountId].contactLids) sessions[accountId].contactLids = {}

    // Bloquear si ya hay una conexión activa o en progreso
    const currentStatus = sessions[accountId].connectionStatus
    if (currentStatus === 'open' || currentStatus === 'connecting' || currentStatus === 'qr_ready') {
        console.log(`[${accountId}] Bloqueando: ya hay una conexión en estado '${currentStatus}'.`)
        return
    }

    sessions[accountId].connectionStatus = 'connecting'
    console.log(`[${accountId}] [MANUAL] Iniciando conexión con nombre: ${sessions[accountId].browserName}...`)

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
    const { version, isLatest } = await fetchLatestWaWebVersion()
    console.log(`[${accountId}] Versión WA: ${version.join('.')} (isLatest: ${isLatest})`)

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: [sessions[accountId].browserName, 'Chrome', '1.0.0'],
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

    // Baileys v7.0.0+: Escuchar actualizaciones de mapeo LID <-> PN
    sock.ev.on('lid-mapping.update', (mappings) => {
        for (const { lid, pn } of mappings) {
            const rawLid = lid.split('@')[0]
            const rawPn = pn.split('@')[0]
            sessions[accountId].contactLids[rawLid] = rawPn
            console.log(`[${accountId}] 🔗 LID MAPPING (Protocol): ${rawLid} -> ${rawPn}`)
        }
    })

    // Poblar caché de nombres desde la agenda del dispositivo vinculado
    // Esto permite resolver el nombre del contacto en mensajes salientes
    function mergeContactNames(contactList) {
        if (!Array.isArray(contactList)) return
        const map = sessions[accountId].contactNamesByJid
        const mapLids = sessions[accountId].contactLids

        for (const c of contactList) {
            const jid = c.id || c.jid || ''
            const name = (c.name && String(c.name).trim()) || (c.notify && String(c.notify).trim()) || ''

            if (name && jid) {
                sessions[accountId].contactNamesByJid[jid] = name
                const rawNum = jid.split('@')[0].split(':')[0]
                if (rawNum && /^\d+$/.test(rawNum) && isPnUser(jid)) {
                    sessions[accountId].contactNamesByJid[`${rawNum}@s.whatsapp.net`] = name
                }
            }

            // Capturar mapeo LID -> Real Phone (Baileys v7 usa .phoneNumber o .lid)
            const lid = c.lid ? String(c.lid).split('@')[0] : (jid.includes('@lid') ? jid.split('@')[0] : null)
            const realPhone = c.phoneNumber ? String(c.phoneNumber).split(':')[0] : (!jid.includes('@lid') && isPnUser(jid) ? jid.split('@')[0].split(':')[0] : null)

            if (lid && realPhone && /^\d+$/.test(realPhone)) {
                sessions[accountId].contactLids[lid] = realPhone
                console.log(`[${accountId}] 🔗 LID MAPPING (Contact): ${lid} -> ${realPhone}`)
            }
        }
    }
    sock.ev.on('contacts.upsert', mergeContactNames)
    sock.ev.on('contacts.update', mergeContactNames)
    sock.ev.on('messaging-history.set', async ({ contacts, messages, chats, isLatest }) => {
        if (contacts && contacts.length > 0) {
            console.log(`[${accountId}] 📥 Sincronizando ${contacts.length} contactos desde historial...`)
            mergeContactNames(contacts)
        }
        
        if (messages && messages.length > 0) {
            console.log(`[${accountId}] 📥 Procesando ${messages.length} mensajes desde historial...`)
            // Procesar mensajes históricos de forma secuencial pero eficiente
            for (const msg of messages) {
                await sendToWebhook(accountId, msg, true).catch(err => 
                    console.error(`[${accountId}] Error procesando mensaje histórico:`, err.message)
                )
            }
            console.log(`[${accountId}] ✅ Historial procesado.`)
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

    // Escuchar cambios en participantes de grupos (Entradas/Salidas)
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update

        if (action === 'add') {
            const accountId = Object.keys(sessions).find(aid => sessions[aid].sock === sock) || 'unknown'
            console.log(`[${accountId}] 👥 Nuevos participantes detectados en ${id}`)

            let groupName = 'Grupo Desconocido'
            try {
                // Intentar obtener metadata fresca para el nombre del grupo
                const metadata = await sock.groupMetadata(id)
                groupName = metadata.subject || groupName
                console.log(`[${accountId}] ✅ Procesando ingresos en el grupo: "${groupName}"`)
            } catch (err) {
                console.error(`[${accountId}] Error obteniendo metadata del grupo ${id}:`, err.message)
                // Continuamos aunque falle el nombre, el ID se mantiene
            }

            // Mapear participantes para extraer número y buscar nombre en el caché si existe
            const enrichedParticipants = (await Promise.all(participants.map(async (p) => {
                const jid = (typeof p === 'string') ? p : (p.phoneNumber || p.id || '')
                if (!jid) return null

                let rawNum = jid.split('@')[0].split(':')[0]
                const isLid = jid.includes('@lid')
                const lidMap = sessions[accountId]?.contactLids || {}

                // RESOLUCIÓN FORZADA AL ENTRAR
                if (isLid || rawNum.length > 13) {
                    if (lidMap[rawNum]) {
                        rawNum = lidMap[rawNum]
                    } else if (sock) {
                        try {
                            const results = await sock.onWhatsApp(jid)
                            if (results && results[0]?.exists) {
                                const resolvedPn = results[0].jid.split('@')[0].split(':')[0]
                                if (resolvedPn && /^\d+$/.test(resolvedPn)) {
                                    lidMap[rawNum] = resolvedPn
                                    console.log(`[${accountId}] 🤝 Identidad resuelta al entrar: ${rawNum} -> ${resolvedPn}`)
                                    rawNum = resolvedPn
                                }
                            }
                        } catch (e) { }
                    }
                }

                const contactMap = sessions[accountId]?.contactNamesByJid || {}
                const cleanNumber = rawNum.replace(/^(\d{2})1(\d{10})$/, '$1$2')
                const with1Number = rawNum.length === 12 ? rawNum.replace(/^(\d{2})(\d{10})$/, '$11$2') : rawNum

                let userName = contactMap[jid] ||
                    contactMap[`${rawNum}@s.whatsapp.net`] ||
                    contactMap[`${cleanNumber}@s.whatsapp.net`] ||
                    contactMap[`${with1Number}@s.whatsapp.net`] ||
                    contactMap[rawNum] ||
                    contactMap[cleanNumber]

                if (!userName) {
                    try {
                        const metadata = await sock.groupMetadata(id)
                        const part = metadata.participants.find(part =>
                            part.id === jid || part.id.includes(cleanNumber) || part.id.includes(rawNum)
                        )
                        if (part && (part.name || part.notify)) userName = part.name || part.notify
                    } catch (e) { }
                }

                console.log(`[${accountId}] 🔍 Integrante: ${rawNum} (${userName || 'Nuevo Usuario'})`)

                return {
                    phoneNumber: rawNum,
                    userName: userName || 'Nuevo Usuario'
                }
            }))).filter(p => p !== null)

            // Enviar exclusivamente a SoyAndrade vía Webhook
            const soyAndradeWebhook = process.env.SOYANDRADE_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-sync/webhook'
            const companyId = sessions[accountId]?.companyId || null

            try {
                console.log(`[${accountId}] 📡 Enviando lead de grupo a SoyAndrade: ${soyAndradeWebhook}`)
                const response = await fetch(soyAndradeWebhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'group_join',
                        accountId,
                        companyId,
                        groupId: id,
                        groupName,
                        participants: enrichedParticipants,
                        timestamp: Date.now()
                    })
                })

                if (response.ok) {
                    console.log(`[${accountId}] ✅ Lead registrado con éxito en SoyAndrade.`)
                } else {
                    console.error(`[${accountId}] ⚠️  SoyAndrade respondió con error (${response.status})`)
                }
            } catch (err) {
                console.error(`[${accountId}] ❌ Error conectando con el webhook de SoyAndrade:`, err.message)
            }
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
        // Baileys v7.0.0+ LID Resolution
        let cleanNumber = remoteJid ? remoteJid.split('@')[0].split(':')[0] : 'Desconocido'
        const isLid = remoteJid && remoteJid.includes('@lid')

        if (isLid) {
            const rawLid = remoteJid.split('@')[0]
            // Intentar resolución nativa vía signalRepository
            const nativePn = await sessions[accountId]?.sock?.signalRepository?.lidMapping?.getPNForLID(remoteJid)
            const mappedPn = nativePn ? nativePn.split('@')[0] : sessions[accountId]?.contactLids?.[rawLid]

            if (mappedPn) {
                cleanNumber = mappedPn
                remoteJid = `${mappedPn}@s.whatsapp.net`
                console.log(`[${accountId}] 💥 LID RESOLVED (Native/Mem): ${rawLid} -> ${mappedPn}`)
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

        // Ignorar estados
        if (remoteJid === 'status@broadcast') continue

        // 1. DETERMINAR IDENTIDAD (Resolver LID -> Teléfono)
        const targetJid = participant || remoteJid
        if (!targetJid) continue

        let rawNum = targetJid.split('@')[0].split(':')[0]
        const isLidIdentity = targetJid.includes('@lid')
        const lidMap = sessions[accountId]?.contactLids || {}

        // Intentar resolver el teléfono si es un LID o número muy largo
        if (isLidIdentity || rawNum.length > 13) {
            const originalLid = rawNum
            
            // Re-intento de resolución:
            // a) Mapeo interno
            if (lidMap[originalLid]) {
                rawNum = lidMap[originalLid]
            } else {
                // b) Resolución nativa (v7 signal repo)
                const fullLidJid = isLidIdentity ? targetJid : `${originalLid}@lid`
                try {
                    const res = await sessions[accountId]?.sock?.signalRepository?.lidMapping?.getPNForLID(fullLidJid)
                    if (res) {
                        rawNum = res.split('@')[0].split(':')[0]
                        lidMap[originalLid] = rawNum
                        console.log(`[${accountId}] 🔗 LID Traducido (Nativo): ${originalLid} -> ${rawNum}`)
                    } else if (sessions[accountId]?.sock) {
                        // c) Resolución dinámica via onWhatsApp
                        const results = await sessions[accountId].sock.onWhatsApp(fullLidJid)
                        if (results && results[0]?.exists) {
                            rawNum = results[0].jid.split('@')[0].split(':')[0]
                            lidMap[originalLid] = rawNum
                            console.log(`[${accountId}] 🔄 LID Traducido (Dinámico): ${originalLid} -> ${rawNum}`)
                        }
                    }
                } catch (e) {
                    console.warn(`[${accountId}] Error resolviendo LID ${originalLid}:`, e.message)
                }
            }
        }

        // 2. ACTUALIZAR CACHÉ Y NOTIFICAR AL CRM
        const pushName = msg.pushName && String(msg.pushName).trim()
        const contactMap = sessions[accountId]?.contactNamesByJid
        
        if (pushName && contactMap) {
            contactMap[targetJid] = pushName
            contactMap[`${rawNum}@s.whatsapp.net`] = pushName

            // SOLO enviar al CRM si pudimos obtener un número de teléfono real (< 14 dígitos)
            if (rawNum && rawNum.length < 14 && /^\d+$/.test(rawNum)) {
                const soyAndradeWebhook = process.env.SOYANDRADE_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-sync/webhook'
                
                fetch(soyAndradeWebhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'name_update',
                        phoneNumber: rawNum,
                        userName: pushName,
                        timestamp: Date.now()
                    })
                }).catch(() => { })

                if (!sessions[accountId]._lastNotifiedName || sessions[accountId]._lastNotifiedName !== `${rawNum}_${pushName}`) {
                    console.log(`[${accountId}] 📖 Nombre vinculado: ${rawNum} -> ${pushName}`)
                    sessions[accountId]._lastNotifiedName = `${rawNum}_${pushName}`
                }
            } else {
                // Si llegamos aquí y sigue siendo largo, es que falló la traducción
                if (isLidIdentity || rawNum.length >= 14) {
                    console.log(`[${accountId}] ⏳ Nombre en espera (ID aún no resuelto): ${rawNum} -> ${pushName}`)
                }
            }
        }

        // 3. CONTINUAR CON PROCESAMIENTO LEGADO (Bitend, etc.)
        await sendToWebhook(accountId, msg)
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

    // Baileys v7+: Usar isPnUser para validación lógica
    const isPn = isPnUser(jid)
    console.log(`[${accountId}] Enviando a JID resolved: ${jid} (isPn: ${isPn})`)
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


