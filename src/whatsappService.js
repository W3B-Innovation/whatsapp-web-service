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
                        origin: null,
                        activeGroupId: null,
                        activeGroupName: null,
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
                number: sessions[id].number,
                origin: sessions[id].origin,
                activeGroupId: sessions[id].activeGroupId,
                activeGroupName: sessions[id].activeGroupName
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

/**
 * Determina a qué webhook enviar la información basado en el origen de la sesión
 */
function getWebhookUrl(accountId) {
    const session = sessions[accountId];
    const origin = session?.origin || '';

    // 1. Prioridad: Subdominio específico de Códigos
    if (origin.includes('codigos.soyandrade.com')) {
        return process.env.CODIGOS_WEBHOOK_URL || 'https://codigos.soyandrade.com/api/whatsapp/web-sync/webhook';
    }

    // 2. Dominio principal de Soy Andrade
    if (origin.includes('soyandrade.com') || accountId.startsWith('SOYANDRADE_')) {
        return process.env.SOYANDRADE_WEBHOOK_URL || 'https://soyandrade.com/api/whatsapp/web-sync/webhook';
    }

    // 3. CRM por defecto (Bitend)
    return process.env.CRM_WEBHOOK_URL || 'https://crm.bitend.ai/api/whatsapp/web-sync/webhook';
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
        let mapped = session.contactLids[originalLid]

        // v7: Intentar resolución nativa si no hay mapeo en caché
        if (!mapped && session.sock?.signalRepository?.lidMapping) {
            try {
                const res = await session.sock.signalRepository.lidMapping.getPNForLID(remoteJid)
                if (res) {
                    mapped = res.split('@')[0]
                    session.contactLids[originalLid] = mapped
                    console.log(`[${accountId}] 🔗 LID Traducido (sendToWebhook): ${originalLid} -> ${mapped}`)
                }
            } catch (e) {
                console.warn(`[${accountId}] Error resolviendo LID en webhook:`, e.message)
            }
        }

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

        const webhookUrl = getWebhookUrl(accountId)

        try {
            if (isHistory) {
                console.log(`[${accountId}] 🕒 Enviando HISTORIAL al CRM: ${finalCleanNumber} (${text.substring(0, 20)}...)`)
            }

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
                    origin: session.origin,
                    timestamp: msg.messageTimestamp,
                    pushName: (() => {
                        const map = session.contactNamesByJid || {}
                        const cachedName = map[remoteJid] || map[`${finalCleanNumber}@s.whatsapp.net`]

                        // Si el mensaje es entrante, capturar el pushName del remitente
                        if (!fromMe) {
                            const inboundName = msg.pushName && String(msg.pushName).trim()
                            if (inboundName) {
                                map[remoteJid] = inboundName
                                map[`${finalCleanNumber}@s.whatsapp.net`] = inboundName
                                return inboundName
                            }
                        }

                        // Si el mensaje es saliente o no tiene pushName entrante, usar el caché (que debería tener el nombre del contacto)
                        // NUNCA devolver el pushName del mensaje si fromMe es true, porque sería nuestro propio nombre.
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
/**
    * Envía un webhook al CRM informando que se ha descubierto o actualizado el nombre de un contacto.
    */
async function notifyNameUpdate(accountId, phoneNumber, userName) {
    const webhookUrl = getWebhookUrl(accountId)
    try {
        // Evitar spam de actualizaciones si el nombre es redundante
        // (Opcional: podrías implementar un pequeño caché de 'nombres ya enviados' aquí)

        fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'name_update',
                accountId,
                companyId: sessions[accountId]?.companyId || null,
                phoneNumber,
                userName,
                origin: sessions[accountId]?.origin || null,
                timestamp: Date.now()
            })
        }).catch(() => { }) // Silencioso
    } catch (e) { }
}
export async function connectToWhatsApp(accountId = 'default', companyId = null, browserName = 'Bitend AI CRM', origin = null, activeGroupId = null, activeGroupName = null) {
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
            origin: origin,
            activeGroupId: activeGroupId,
            activeGroupName: activeGroupName
        }
    }

    // SIEMPRE actualizar companyId, browserName y origin si se proveen
    if (companyId) sessions[accountId].companyId = companyId
    if (browserName) sessions[accountId].browserName = browserName
    if (origin) sessions[accountId].origin = origin
    if (activeGroupId) sessions[accountId].activeGroupId = activeGroupId
    if (activeGroupName) sessions[accountId].activeGroupName = activeGroupName

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
        syncFullHistory: false, // DESACTIVADO: No recuperar historial completo al conectar
        markOnlineOnConnect: false,
        linkPreviewImageThumbnailWidth: 192,
        // DESACTIVADO: Evita que Baileys procese los paquetes de historial.
        shouldSyncHistoryMessage: () => false,
        // Ayuda a Baileys a recuperar contenido de mensajes si es necesario
        getMessage: async (key) => {
            return {
                conversation: '...' // Placeholder o implementación real si hubiera store
            }
        }
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

            // No guardar nuestro propio nombre como nombre de contacto
            if (name && jid && jid !== sessions[accountId].sock?.user?.id?.split(':')[0] + '@s.whatsapp.net') {
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
            console.log(`[${accountId}] 📥 Sincronizando ${contacts.length} contactos desde historial... (isLatest: ${isLatest})`)
            mergeContactNames(contacts)
        }

        if (chats && chats.length > 0) {
            console.log(`[${accountId}] 📥 Sincronizando ${chats.length} chats desde historial...`)
            mergeContactNames(chats) // Los chats también tienen ID y Name
        }

        if (messages && messages.length > 0) {
            // DESACTIVADO: Ya no procesamos mensajes de historial para enviarlos al CRM
            // console.log(`[${accountId}] 📥 Procesando ${messages.length} mensajes desde historial...`)
            // await handleMessages(accountId, { messages, type: 'notify' }, true)
            // console.log(`[${accountId}] ✅ Historial procesado.`)
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

            // Si fue un logout intencional por duplicado, no reintentar
            if (sessions[accountId].connectionStatus === 'error_duplicate_number') {
                console.log(`[${accountId}] 🛑 Logout por duplicado completado.`)
                return
            }

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

            // VALIDACIÓN: Evitar números duplicados en diferentes cuentas
            const otherAccountId = Object.keys(sessions).find(id =>
                id !== accountId &&
                sessions[id].number === cleanNumber &&
                sessions[id].connectionStatus === 'open'
            )

            if (otherAccountId) {
                console.log(`[${accountId}] ⚠️ CONFLICTO: El número ${cleanNumber} ya está vinculado a '${otherAccountId}'. Cerrando sesión...`)

                sessions[accountId].connectionStatus = 'error_duplicate_number'
                sessions[accountId].duplicateConflictId = otherAccountId
                sessions[accountId].duplicateConflictOrigin = sessions[otherAccountId].origin || 'Otro CRM'

                try {
                    await sock.logout() // Desvincular el nuevo intento inmediatamente
                } catch (e) {
                    console.error(`[${accountId}] Error en logout por duplicado:`, e.message)
                }
                return
            }

            sessions[accountId].connectionStatus = 'open'
            sessions[accountId].lastQr = null
            sessions[accountId].number = cleanNumber
            sessions[accountId].duplicateConflictId = null // Limpiar conflictos anteriores
            sessions[accountId].duplicateConflictOrigin = null

            savePersistentSessions()
            console.log(`[${accountId}] ✅ ¡Conectado exitosamente! Número: ${cleanNumber}`)
        }
    })

    // Escuchar cambios en participantes de grupos (Entradas/Salidas)
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update

        if (action === 'add' || action === 'remove' || action === 'leave') {
            const accountId = Object.keys(sessions).find(aid => sessions[aid].sock === sock) || 'unknown'
            const isJoin = action === 'add'

            console.log(`[${accountId}] 👥 Cambio en participantes (${action}) detectado en ${id}`)

            let groupName = 'Grupo Desconocido'
            try {
                const metadata = await sock.groupMetadata(id)
                groupName = metadata.subject || groupName
                console.log(`[${accountId}] ✅ Procesando ${isJoin ? 'ingresos' : 'salidas'} en el grupo: "${groupName}"`)
            } catch (err) {
                console.error(`[${accountId}] Error obteniendo metadata del grupo ${id}:`, err.message)
            }

            const enrichedParticipants = (await Promise.all(participants.map(async (p) => {
                const jid = (typeof p === 'string') ? p : (p.phoneNumber || p.id || '')
                if (!jid) return null

                let rawNum = jid.split('@')[0].split(':')[0]
                const isLid = jid.includes('@lid')
                const lidMap = sessions[accountId]?.contactLids || {}

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
                                    rawNum = resolvedPn
                                }
                            }
                        } catch (e) { }
                    }
                }

                const contactMap = sessions[accountId]?.contactNamesByJid || {}
                const cleanNumber = rawNum.replace(/^(\d{2})1(\d{10})$/, '$1$2')

                let userName = contactMap[jid] ||
                    contactMap[`${rawNum}@s.whatsapp.net`] ||
                    contactMap[rawNum]

                return {
                    phoneNumber: rawNum,
                    userName: userName || 'Usuario'
                }
            }))).filter(p => p !== null)

            const webhookUrl = getWebhookUrl(accountId)
            const companyId = sessions[accountId]?.companyId || null

            try {
                const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: isJoin ? 'group_join' : 'group_leave',
                        action: action, // 'add', 'remove', 'leave'
                        accountId,
                        companyId,
                        origin: sessions[accountId]?.origin || null,
                        groupId: id,
                        groupName,
                        participants: enrichedParticipants,
                        timestamp: Date.now()
                    })
                })
                const resBody = await response.json().catch(() => ({}));
                if (response.ok) {
                    console.log(`[${accountId}] ✅ Evento '${action}' enviado al CRM (${webhookUrl}). Respuesta:`, JSON.stringify(resBody));
                } else {
                    console.error(`[${accountId}] ❌ Error en respuesta CRM (${response.status}) en ${webhookUrl}:`, JSON.stringify(resBody));
                }
            } catch (err) {
                console.error(`[${accountId}] ❌ Error enviando webhook de grupo:`, err.message)
            }
        }
    })

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async (upsert) => {
        if (upsert.messages?.length > 0 && upsert.type === 'notify') {
            console.log(`[${accountId}] 📥 Mensaje en tiempo real: ${upsert.messages[0].key.remoteJid}`);
            await handleMessages(accountId, upsert, false)
        }
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
        const webhookUrl = getWebhookUrl(accountId)
        const companyId = sessions[accountId]?.companyId || null;

        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'status_update',
                    accountId,
                    companyId,
                    origin: sessions[accountId]?.origin || null,
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
export async function handleMessages(accountId, { messages, type }, isHistory = false) {
    if (type !== 'notify') return

    // Solo procesamos mensajes en tiempo real (notify)
    const finalIsHistory = isHistory

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
            if (lidMap[originalLid]) {
                rawNum = lidMap[originalLid]
            } else {
                const fullLidJid = isLidIdentity ? targetJid : `${originalLid}@lid`
                try {
                    const sock = sessions[accountId]?.sock
                    const res = await sock?.signalRepository?.lidMapping?.getPNForLID(fullLidJid)

                    if (res) {
                        rawNum = res.split('@')[0].split(':')[0]
                        lidMap[originalLid] = rawNum
                        console.log(`[${accountId}] 🔗 LID Traducido (Nativo): ${originalLid} -> ${rawNum}`)
                    } else if (sock) {
                        const results = await sock.onWhatsApp(fullLidJid)
                        if (results && results[0]?.exists && results[0].jid.includes('@s.whatsapp.net')) {
                            rawNum = results[0].jid.split('@')[0].split(':')[0]
                            lidMap[originalLid] = rawNum
                            console.log(`[${accountId}] 🔄 LID Traducido (onWhatsApp): ${originalLid} -> ${rawNum}`)
                        }
                    }
                } catch (e) { }
            }

            // Actualizar el remoteJid del mensaje para que el webhook use el número real
            if (rawNum && rawNum.length < 14) {
                msg.key.remoteJid = `${rawNum}@s.whatsapp.net`
            }
        }

        // 2. ACTUALIZAR CACHÉ DE NOMBRES
        const pushName = !fromMe ? (msg.pushName && String(msg.pushName).trim()) : null
        if (pushName && sessions[accountId]?.contactNamesByJid) {
            sessions[accountId].contactNamesByJid[targetJid] = pushName
            if (rawNum && rawNum.length < 14) {
                sessions[accountId].contactNamesByJid[`${rawNum}@s.whatsapp.net`] = pushName
            }
        }

        // 3. CONTINUAR CON PROCESAMIENTO (Bitend, etc.)
        await sendToWebhook(accountId, msg, finalIsHistory)
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

export async function sendMessage(accountId = 'default', number, message, media = null) {
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
    
    if (media && media.url) {
        console.log(`[${accountId}] Enviando MULTIMEDIA (${media.type}) a JID resolved: ${jid}`)
        const mediaContent = { url: media.url };
        const messageOptions = {
            caption: message,
            mimetype: media.type === 'video' ? 'video/mp4' : 'image/jpeg'
        };

        if (media.type === 'video') {
            return await session.sock.sendMessage(jid, { video: mediaContent, ...messageOptions });
        } else {
            return await session.sock.sendMessage(jid, { image: mediaContent, ...messageOptions });
        }
    }

    console.log(`[${accountId}] Enviando TEXTO a JID resolved: ${jid} (isPn: ${isPn})`)
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

/**
 * Obtiene todos los grupos donde la cuenta está participando.
 * Marca si la cuenta es el Owner (creador).
 */
export async function getGroups(accountId = 'default') {
    const session = sessions[accountId]
    if (!session || !session.sock || session.connectionStatus !== 'open') {
        throw new Error(`WhatsApp no está conectado para la cuenta ${accountId}`)
    }

    try {
        console.log(`[${accountId}] Consultando grupos donde soy administrador...`)
        const groups = await session.sock.groupFetchAllParticipating()
        const myJid = session.sock.user.id.split(':')[0] + '@s.whatsapp.net'
        const myBareId = session.sock.user.id.split(':')[0]

        const filtered = []
        const groupList = Object.values(groups)

        console.log(`[DEBUG:Groups] Mi ID base: ${myBareId}. Iniciando procesamiento de ${groupList.length} grupos...`)

        for (const g of groupList) {
            try {
                const metadata = g
                const ownerJid = metadata.owner || (metadata.id.includes('-') ? metadata.id.split('-')[0] + '@s.whatsapp.net' : null)

                filtered.push({
                    id: metadata.id,
                    subject: metadata.subject,
                    owner: ownerJid,
                    creation: metadata.creation,
                    size: metadata.participants?.length || 0,
                    isOwner: ownerJid === myJid || metadata.id.startsWith(myBareId)
                })
            } catch (err) {
                console.error(`[DEBUG:Groups] ❌ Error en grupo "${g.subject || g.id}":`, err.message)
            }
        }

        console.log(`[DEBUG:Groups] Fin del proceso. Enviando ${filtered.length} grupos al front.`)
        return filtered.sort((a, b) => b.creation - a.creation)

    } catch (err) {
        console.error(`[${accountId}] Error al obtener grupos:`, err.message)
        throw err
    }
}

/**
 * Genera o recupera el código de invitación de un grupo.
 */
export async function getGroupInvite(accountId = 'default', groupId) {
    const session = sessions[accountId]
    if (!session || !session.sock || session.connectionStatus !== 'open') {
        throw new Error(`WhatsApp no está conectado para la cuenta ${accountId}`)
    }

    try {
        console.log(`[${accountId}] Obteniendo código de invitación para ${groupId}...`)
        const code = await session.sock.groupInviteCode(groupId)
        return `https://chat.whatsapp.com/${code}`
    } catch (err) {
        console.error(`[${accountId}] Error al obtener link de invitación:`, err.message)
        throw err
    }
}

/**
 * Resuelve un enlace (posiblemente con redirecciones) para obtener la información del grupo de WhatsApp.
 */
export async function resolveGroupInfo(accountId = 'default', url) {
    const session = sessions[accountId]
    if (!session || !session.sock || session.connectionStatus !== 'open') {
        throw new Error(`WhatsApp no está conectado para la cuenta ${accountId}`)
    }

    try {
        // Asegurar que la URL sea absoluta
        let normalizedUrl = url.trim()
        if (!normalizedUrl.startsWith('http')) {
            normalizedUrl = `https://${normalizedUrl}`
        }

        console.log(`[${accountId}] [resolve-group] Resolviendo: ${normalizedUrl}`)

        let targetUrl = normalizedUrl
        // 1. Seguir redirecciones si no es un link directo de WhatsApp
        if (!normalizedUrl.includes('chat.whatsapp.com')) {
            console.log(`[${accountId}] [resolve-group] No es link directo, siguiendo redirecciones...`)
            const response = await fetch(normalizedUrl, {
                method: 'GET',
                redirect: 'follow',
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            })
            targetUrl = response.url
            console.log(`[${accountId}] [resolve-group] URL final tras redirección: ${targetUrl}`)

            // Si el destino final tampoco es chat.whatsapp.com, intentar buscar el link en el HTML
            if (!targetUrl.includes('chat.whatsapp.com')) {
                console.log(`[${accountId}] [resolve-group] Buscando link en HTML...`)
                const html = await response.text()
                const patterns = [
                    /chat\.whatsapp\.com\/([a-zA-Z0-9]{20,30})/,
                    /chat\.whatsapp\.com\/invite\/([a-zA-Z0-9]{20,30})/
                ]

                let foundCode = null
                for (const p of patterns) {
                    const match = html.match(p)
                    if (match) {
                        foundCode = match[1]
                        break
                    }
                }

                if (foundCode) {
                    targetUrl = `https://chat.whatsapp.com/${foundCode}`
                    console.log(`[${accountId}] [resolve-group] Link encontrado en HTML: ${targetUrl}`)
                } else {
                    console.error(`[${accountId}] [resolve-group] No se encontró link en HTML.`)
                    throw new Error('No se pudo encontrar un enlace de WhatsApp en el destino indicado.')
                }
            }
        }

        // 2. Extraer el código de invitación
        const code = targetUrl.split('chat.whatsapp.com/')[1]?.split('?')[0]?.replace('invite/', '')?.replace(/\/$/, '')
        if (!code) {
            console.error(`[${accountId}] [resolve-group] Error extrayendo código de: ${targetUrl}`)
            throw new Error('Código de invitación no encontrado en la URL.')
        }

        console.log(`[${accountId}] [resolve-group] Obteniendo metadata de WA para el código: ${code}`)

        // 3. Obtener metadata de WhatsApp
        const info = await session.sock.groupGetInviteInfo(code)
        console.log(`[${accountId}] [resolve-group] ✅ Éxito: ${info.subject} (${info.id})`)

        return {
            id: info.id,
            subject: info.subject,
            owner: info.owner,
            creation: info.creation,
            size: info.size,
            desc: info.desc,
            inviteCode: code,
            finalUrl: `https://chat.whatsapp.com/${code}`
        }
    } catch (err) {
        console.error(`[${accountId}] ❌ Error en resolveGroupInfo:`, err.message)
        throw err
    }
}


/**
 * Actualiza la configuración de una sesión existente
 */
export function updateSessionConfig(accountId, config) {
    if (!sessions[accountId]) return false

    if (config.companyId !== undefined) sessions[accountId].companyId = config.companyId
    if (config.origin !== undefined) sessions[accountId].origin = config.origin
    if (config.activeGroupId !== undefined) sessions[accountId].activeGroupId = config.activeGroupId
    if (config.activeGroupName !== undefined) sessions[accountId].activeGroupName = config.activeGroupName

    savePersistentSessions()
    return true
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


