require('dotenv').config();
const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const kill = require('tree-kill');

// ============================================================================
// GLOBAL ERROR HANDLING
// ============================================================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 4000;
const SECRET_KEY = process.env.SECRET_KEY || 'THISISMYSECURETOKEN';
const SESSION_LIMIT = parseInt(process.env.SESSION_LIMIT || '5', 10);

const TOKENS_DIR = path.resolve(process.cwd(), 'tokens');
const BROWSER_DATA_DIR = path.resolve(process.cwd(), '.wpp_browser_data');

if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });
if (!fs.existsSync(BROWSER_DATA_DIR)) fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });

// ============================================================================
// STATE STORE
// ============================================================================
const sessions = new Map();

// ============================================================================
// PERSISTENCE HELPERS
// ============================================================================
const SESSIONS_FILE = path.resolve(process.cwd(), 'sessions.json');

function loadSessionsFromFile() {
    if (!fs.existsSync(SESSIONS_FILE)) return {};
    try {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        console.error('Error reading sessions file:', e);
        return {};
    }
}

function saveSessionToFile(session, webhookUrl) {
    const data = loadSessionsFromFile();
    data[session] = { webhookUrl };
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error writing sessions file:', e);
    }
}

function removeSessionFromFile(session) {
    const data = loadSessionsFromFile();
    if (data[session]) {
        delete data[session];
        try {
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('Error writing sessions file:', e);
        }
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Valida si un número de teléfono es válido
 * Filtra IDs de grupos, estados, y otros IDs inválidos
 */
function isValidPhoneNumber(phoneId) {
    if (!phoneId || typeof phoneId !== 'string') return false;

    // Remover sufijos de WhatsApp
    const cleanId = phoneId.replace(/@c.us|@g.us|@s.whatsapp.net|@broadcast/g, '');

    // Debe ser solo dígitos
    if (!/^\d+$/.test(cleanId)) return false;

    // Longitud válida (entre 8 y 15 dígitos para números internacionales)
    if (cleanId.length < 8 || cleanId.length > 15) return false;

    // Filtrar IDs que claramente no son números de teléfono
    // IDs de estados/status suelen ser muy largos (>15 dígitos)
    if (cleanId.length > 15) return false;

    return true;
}

/**
 * Determina si un mensaje es de un grupo
 */
function isGroupMessage(message) {
    // Verificar si el ID contiene @g.us (grupo)
    if (message.from && message.from.includes('@g.us')) return true;
    if (message.to && message.to.includes('@g.us')) return true;
    if (message.chatId && message.chatId.includes('@g.us')) return true;

    // Verificar si tiene información de grupo
    if (message.isGroupMsg) return true;
    if (message.chat && message.chat.isGroup) return true;

    return false;
}

/**
 * Determina si un mensaje es un estado/status
 */
function isStatusMessage(message) {
    // Estados usan @broadcast o status@broadcast
    if (message.from && (message.from.includes('@broadcast') || message.from.includes('status'))) return true;
    if (message.to && (message.to.includes('@broadcast') || message.to.includes('status'))) return true;
    if (message.chatId && (message.chatId.includes('@broadcast') || message.chatId.includes('status'))) return true;

    // Verificar tipo de mensaje
    if (message.type === 'status' || message.type === 'e2e_notification') return true;

    // IDs de estados suelen ser muy largos
    const fromId = message.from ? message.from.replace(/@.*$/g, '') : '';
    if (fromId.length > 15) return true;

    return false;
}

/**
 * Extrae el número de teléfono limpio de un mensaje
 */
function extractPhoneNumber(message) {
    let phoneId = null;

    // Determinar el ID correcto según la dirección del mensaje
    if (message.fromMe) {
        // Mensaje saliente: usar 'to'
        phoneId = message.to || message.chatId;
    } else {
        // Mensaje entrante: usar 'from'
        phoneId = message.from || message.chatId;
    }

    if (!phoneId) return null;

    // Si es grupo, extraer el número del participante (sender)
    if (isGroupMessage(message)) {
        // Para grupos, usar el sender/participant
        phoneId = message.sender?.id || message.author || message.participant;
        if (!phoneId) return null;
    }

    // Limpiar el ID
    const cleanPhone = phoneId.replace(/@c.us|@g.us|@s.whatsapp.net|@broadcast/g, '');

    // Validar
    if (!isValidPhoneNumber(cleanPhone)) {
        console.log(`[Filter] Invalid phone number: ${cleanPhone} from ${phoneId}`);
        return null;
    }

    return cleanPhone;
}

/**
 * Obtiene el nombre del contacto
 */
async function getContactName(client, phoneId) {
    try {
        const contact = await client.getContact(phoneId);
        return contact?.name || contact?.pushname || contact?.verifiedName || null;
    } catch (e) {
        console.warn(`Could not get contact name for ${phoneId}:`, e.message);
        return null;
    }
}

/**
 * Obtiene información del grupo
 */
async function getGroupInfo(client, groupId) {
    try {
        const chat = await client.getChatById(groupId);
        return {
            name: chat?.name || chat?.contact?.name || 'Grupo',
            isGroup: true
        };
    } catch (e) {
        console.warn(`Could not get group info for ${groupId}:`, e.message);
        return { name: 'Grupo', isGroup: true };
    }
}

async function sendWebhook(url, event, data) {
    if (!url) {
        console.warn('⚠️ [Webhook] No URL provided, skipping event:', event);
        return;
    }
    console.log(`🚀 [Webhook] Sending ${event} to ${url}`);
    try {
        const payload = { event, ...data };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            console.error(`❌ [Webhook] Failed to send to ${url}: ${res.status} ${res.statusText}`);
            const text = await res.text();
            console.error(`❌ [Webhook] Response body:`, text);
        } else {
            console.log(`✅ [Webhook] Successfully sent ${event} to ${url}`);
        }
    } catch (err) {
        console.error(`❌ [Webhook] Error sending to ${url}:`, err.message);
    }
}

// ============================================================================
// WPPCONNECT LOGIC
// ============================================================================

const termitateSession = async (session) => {
    const data = sessions.get(session);

    if (data && data.client) {
        try {
            await data.client.close();
        } catch (e) {
            console.error('Error closing client:', e.message);
        }
    }

    if (data && data.pid) {
        try {
            console.log(`Force killing browser process tree for ${data.pid}...`);
            await new Promise((resolve) => {
                kill(data.pid, 'SIGKILL', (err) => {
                    if (err) console.warn(`Kill failed for ${data.pid}:`, err.message);
                    resolve();
                });
            });
            console.log(`Process tree ${data.pid} kill signal sent.`);
        } catch (e) {
            // Ignore error
        }
    }

    await new Promise(resolve => setTimeout(resolve, 3000));

    const attemptCleanup = async (pathStr) => {
        for (let i = 0; i < 10; i++) {
            try {
                if (fs.existsSync(pathStr)) {
                    fs.rmSync(pathStr, { recursive: true, force: true });
                }
                break;
            } catch (e) {
                if (i === 9) console.error(`Final failure deleting ${pathStr}: ${e.message}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    };

    await attemptCleanup(path.join(TOKENS_DIR, session));

    if (data && data.browserPath) {
        await attemptCleanup(data.browserPath);
    } else {
        await attemptCleanup(path.join(BROWSER_DATA_DIR, session));
    }

    sessions.delete(session);
    removeSessionFromFile(session);
};

const startWppSession = async (sessionName, webhookUrl, res = null) => {
    const serviceStartTime = Math.floor(Date.now() / 1000);

    if (!sessions.has(sessionName) && sessions.size >= SESSION_LIMIT) {
        const error = `Session limit of ${SESSION_LIMIT} reached.`;
        if (res) return res.status(403).json({ error });
        return;
    }

    if (!sessions.has(sessionName)) {
        sessions.set(sessionName, {
            client: null,
            status: 'INITIALIZING',
            webhookUrl,
            qr: null
        });
    }

    const sessionData = sessions.get(sessionName);
    sessionData.webhookUrl = webhookUrl;

    saveSessionToFile(sessionName, webhookUrl);

    let responseSent = false;
    const sendResponse = (data) => {
        if (res && !responseSent) {
            res.json(data);
            responseSent = true;
        }
    };
    const sendError = (code, msg) => {
        if (res && !responseSent) {
            res.status(code).json({ error: msg });
            responseSent = true;
        }
    };

    try {
        console.log(`Starting session: ${sessionName}`);

        // Garbage collection
        try {
            if (fs.existsSync(BROWSER_DATA_DIR)) {
                const files = fs.readdirSync(BROWSER_DATA_DIR);
                for (const file of files) {
                    if (file.startsWith(`${sessionName}-`) || file === sessionName) {
                        const oldPath = path.join(BROWSER_DATA_DIR, file);
                        try {
                            console.log(`GC: Deleting stale folder ${oldPath}`);
                            fs.rmSync(oldPath, { recursive: true, force: true });
                        } catch (e) {
                            console.warn(`GC: Could not delete ${oldPath} (might be locked): ${e.message}`);
                        }
                    }
                }
            }
        } catch (e) { console.error('GC Error:', e); }

        const uniqueId = `${sessionName}-${Date.now()}`;
        const uniqueBrowserPath = path.join(BROWSER_DATA_DIR, uniqueId);

        sessionData.browserPath = uniqueBrowserPath;

        const standardPath = path.join(BROWSER_DATA_DIR, sessionName);
        if (fs.existsSync(standardPath)) {
            try {
                fs.rmSync(standardPath, { recursive: true, force: true });
            } catch (e) { /* ignore */ }
        }

        const client = await wppconnect.create({
            session: sessionName,
            catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
                console.log(`QR received for ${sessionName}, attempt ${attempts}`);
                sessionData.qr = base64Qr;
                sessionData.status = 'WAITING_QR';

                sendResponse({
                    status: 'QR_GENERATED',
                    qr: base64Qr,
                    attempts
                });

                if (attempts === 1) {
                    setTimeout(async () => {
                        const currentSession = sessions.get(sessionName);
                        if (currentSession && (currentSession.status === 'WAITING_QR' || currentSession.status === 'INITIALIZING')) {
                            console.log(`Session ${sessionName} timed out (QR not scanned). Cleaning up...`);
                            await termitateSession(sessionName);
                            sendWebhook(webhookUrl, 'status_change', { session: sessionName, status: 'qr_expired' });
                        }
                    }, 60000);
                }
            },
            statusFind: (statusSession, session) => {
                console.log(`Status change for ${sessionName}: ${statusSession}`);
                sessionData.status = statusSession;

                sendWebhook(webhookUrl, 'status_change', { session: sessionName, status: statusSession });

                if (statusSession === 'inChat' || statusSession === 'isLogged') {
                    sessionData.qr = null;
                }
            },
            headless: true,
            devtools: false,
            useChrome: true,
            debug: false,
            logQR: false,
            disableWelcome: true,
            updatesLog: true,
            autoClose: 60000,
            waitForLogin: true,
            whatsappVersion: '2.3000.10305x',
            tokenStore: 'file',
            folderNameToken: TOKENS_DIR,
            puppeteerOptions: {
                userDataDir: uniqueBrowserPath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-crash-reporter',
                    '--disable-breakpad',
                    '--no-crash-upload',
                    '--disable-dev-shm-usage',
                    '--disable-extensions',
                    '--window-size=1920,1080',
                    '--disable-site-isolation-trials',
                    '--no-experiments',
                    '--ignore-gpu-blacklist',
                    '--ignore-certificate-errors',
                    '--ignore-certificate-errors-spki-list',
                    '--disable-gpu',
                    '--disable-default-apps',
                    '--enable-features=NetworkService',
                    '--disable-blink-features=AutomationControlled',
                    '--autoplay-policy=no-user-gesture-required'
                ]
            }
        });

        sessionData.client = client;

        // Capture PID
        try {
            let browser = null;
            if (client.page && client.page.browser) browser = client.page.browser();
            else if (client.browser) browser = client.browser;

            if (browser) {
                const proc = browser.process();
                if (proc) {
                    sessionData.pid = proc.pid;
                    console.log(`Captured PID for ${sessionName}: ${proc.pid}`);
                }
            }
        } catch (e) { console.error('Could not capture browser PID:', e); }

        // ============================================================================
        // MENSAJE HANDLER - MEJORADO CON FILTROS
        // ============================================================================
        client.onAnyMessage(async (message) => {
            try {
                // 1. VALIDAR TIMESTAMP
                let ts = message.timestamp;
                if (ts && ts > 1000000000000) {
                    ts = Math.floor(ts / 1000);
                }

                console.log(`[DEBUG] Msg: ${message.id} | Type: ${message.type} | From: ${message.from} | TS: ${ts}`);

                // Ignorar mensajes antiguos
                if (!ts || ts < serviceStartTime) {
                    console.log(`[Filter] Skipping old message: ${ts} < ${serviceStartTime}`);
                    return;
                }

                // 2. FILTRAR ESTADOS/STATUS
                if (isStatusMessage(message)) {
                    console.log(`[Filter] Skipping status/broadcast message from ${message.from}`);
                    return;
                }

                // 3. VALIDAR TIPO DE MENSAJE
                const validTypes = ['chat', 'image', 'video', 'ptt', 'audio', 'sticker', 'document', 'vcard', 'location', 'multi_vcard'];
                if (!validTypes.includes(message.type)) {
                    console.log(`[Filter] Skipping invalid message type: ${message.type}`);
                    return;
                }

                // 4. FILTRAR MENSAJES VACÍOS
                if (message.type === 'chat' && !message.body) {
                    console.log(`[Filter] Skipping empty chat message`);
                    return;
                }

                // 5. EXTRAER NÚMERO DE TELÉFONO VÁLIDO
                const phoneNumber = extractPhoneNumber(message);
                if (!phoneNumber) {
                    console.log(`[Filter] Could not extract valid phone number from message`);
                    return;
                }

                console.log(`[Valid] Processing message from phone: ${phoneNumber}`);

                // 6. DETERMINAR SI ES GRUPO
                const isGroup = isGroupMessage(message);
                let contactName = null;
                let groupName = null;

                if (isGroup) {
                    // Obtener información del grupo
                    const groupInfo = await getGroupInfo(client, message.from || message.chatId);
                    groupName = groupInfo.name;

                    // Para grupos, también obtener el nombre del participante
                    const participantId = message.sender?.id || message.author || message.participant;
                    if (participantId) {
                        contactName = await getContactName(client, participantId);
                    }

                    console.log(`[Group] Message from group "${groupName}", participant: ${contactName || phoneNumber}`);
                } else {
                    // Mensaje individual
                    contactName = await getContactName(client, message.from || message.to);
                    console.log(`[Individual] Message from contact: ${contactName || phoneNumber}`);
                }

                // 7. PROCESAR MEDIA
                let cleanBody = message.body;
                let mediaData = null;

                const mediaTypes = ['image', 'video', 'ptt', 'audio', 'sticker', 'document', 'vcard', 'location'];

                if (mediaTypes.includes(message.type)) {
                    console.log(`[Media] Detected media message: ${message.type}`);
                    cleanBody = `[${message.type}]`;

                    if (['image', 'video', 'ptt', 'audio', 'sticker', 'document'].includes(message.type)) {
                        try {
                            console.log(`[Media] Downloading content for ${message.id}...`);
                            const result = await client.downloadMedia(message);
                            if (result) {
                                if (Buffer.isBuffer(result)) {
                                    mediaData = result.toString('base64');
                                } else if (typeof result === 'string') {
                                    if (result.startsWith('data:')) {
                                        mediaData = result.split(',')[1];
                                    } else {
                                        mediaData = result;
                                    }
                                }
                                console.log(`[Media] Download success. Base64 length: ${mediaData.length}`);
                            }
                        } catch (err) {
                            console.error(`Error downloading media for message ${message.id}:`, err);
                            cleanBody = `[Error descargando ${message.type}]`;
                        }
                    }
                }

                // Limitar longitud de texto
                if (!mediaData && cleanBody && cleanBody.length > 2000) {
                    cleanBody = '[Contenido largo/Media]';
                }

                // 8. CONSTRUIR PAYLOAD
                const cleanPayload = (obj) => JSON.parse(JSON.stringify(obj));

                const payload = cleanPayload({
                    session: sessionName,
                    message: {
                        id: message.id || '',
                        from: message.from || '',
                        to: message.to || '',
                        body: cleanBody || '',
                        type: message.type || '',
                        fromMe: message.fromMe || false,
                        timestamp: ts || Math.floor(Date.now() / 1000),
                        phoneNumber: phoneNumber,
                        contactName: contactName,
                        isGroup: isGroup,
                        groupName: groupName,
                        sender: message.sender || {},
                        mediaData: mediaData || null,
                        mimetype: message.mimetype || ''
                    }
                });

                console.log(`[Webhook] Sending message to webhook - Phone: ${phoneNumber}, IsGroup: ${isGroup}, Group: ${groupName || 'N/A'}`);
                sendWebhook(webhookUrl, 'on_message', payload);

            } catch (error) {
                console.error(`[Error] Processing message ${message.id}:`, error);
            }
        });

        if (!responseSent) {
            const state = await client.getConnectionState();
            if (state === 'CONNECTED') {
                sendResponse({ status: 'ALREADY_CONNECTED', message: 'Session is already active and connected.' });
            }
        }

    } catch (err) {
        console.error('Error creating session:', err);
        sendError(500, err.message);
        sessions.delete(sessionName);
        removeSessionFromFile(sessionName);
    }
};

// ============================================================================
// SERVER
// ============================================================================
const app = express();
app.use(express.json());

app.post('/api/session/start-session', async (req, res) => {
    const { session, webhook } = req.body;
    if (!session) return res.status(400).json({ error: 'Session name is required' });

    const existing = sessions.get(session);
    if (existing && existing.client) {
        try {
            const state = await existing.client.getConnectionState();
            if (state === 'CONNECTED') {
                return res.json({ status: 'ALREADY_CONNECTED', message: 'Session is active' });
            } else {
                console.log(`Session ${session} exists but is state ${state}. Terminating to restart.`);
                await termitateSession(session);
            }
        } catch (e) {
            await termitateSession(session);
        }
    } else if (existing) {
        await termitateSession(session);
    }

    startWppSession(session, webhook, res);
});

app.get('/api/sessions', (req, res) => {
    const list = [];
    sessions.forEach((val, key) => {
        list.push({
            session: key,
            status: val.status,
            hasClient: !!val.client,
            webhookUrl: val.webhookUrl
        });
    });
    res.json({ sessions: list });
});

app.get('/api/session/:session/status', async (req, res) => {
    const { session } = req.params;
    const data = sessions.get(session);
    if (!data) return res.status(404).json({ error: 'Session not found' });

    let connectionState = 'UNKNOWN';
    if (data.client) {
        try {
            connectionState = await data.client.getConnectionState();
        } catch (e) { connectionState = 'ERROR'; }
    }

    res.json({
        session,
        status: data.status,
        connectionState,
        qrAvailable: !!data.qr
    });
});

app.post('/api/session/:session/terminate', async (req, res) => {
    const { session } = req.params;
    await termitateSession(session);
    res.json({ success: true });
});

app.post('/api/session/:session/send-message', async (req, res) => {
    const { session } = req.params;
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message are required' });
    }

    const sessionData = sessions.get(session);
    if (!sessionData || !sessionData.client) {
        return res.status(404).json({ error: 'Session not found or not connected' });
    }

    try {
        let destination = phone.toString().trim();
        destination = destination.replace(/[^\d@\-]/g, '');

        if (!destination.includes('@')) {
            destination = `${destination}@c.us`;
        }

        console.log(`[Send] Processing send request for ${destination} on session ${session}`);

        try {
            const result = await sessionData.client.checkNumberStatus(destination);
            if (result && result.numberExists && result.id && result.id._serialized) {
                console.log(`[Send] Resolved ${destination} to canonical ID: ${result.id._serialized}`);
                destination = result.id._serialized;
            } else if (result && !result.numberExists) {
                console.warn(`[Send] Warning: WhatsApp says ${destination} does not exist.`);
                return res.status(400).json({ error: 'Number does not exist on WhatsApp', details: result });
            }
        } catch (e) {
            console.warn(`[Send] checkNumberStatus failed for ${destination}: ${e.message}. Attempting to send using raw JID.`);
        }

        const result = await sessionData.client.sendText(destination, message);
        console.log(`[Send] Message sent successfully to ${destination}. MsgID: ${result?.id}`);

        res.json({ success: true, message: 'Message sent', messageId: result?.id, to: destination });
    } catch (error) {
        console.error(`Error sending message on session ${session}:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/session/:session/call', async (req, res) => {
    const { session } = req.params;
    const { phone, isVideo } = req.body;

    if (!phone) {
        return res.status(400).json({ error: 'Phone is required' });
    }

    const sessionData = sessions.get(session);
    if (!sessionData || !sessionData.client) {
        return res.status(404).json({ error: 'Session not found or not connected' });
    }

    try {
        let destination = phone.toString().trim();
        destination = destination.replace(/[^\d@\-]/g, '');

        if (!destination.includes('@')) {
            destination = `${destination}@c.us`;
        }

        console.log(`[Call] Attempting to call ${destination} on session ${session}`);

        const result = await sessionData.client.page.evaluate(async (to, video) => {
            if (typeof window.WPP === 'undefined') {
                throw new Error('WPP is not injected or not ready');
            }
            if (!window.WPP.call) {
                throw new Error('WPP.call namespace is missing');
            }
            return await window.WPP.call.offer(to, { isVideo: !!video });
        }, destination, isVideo);

        console.log(`[Call] Call initiated successfully:`, result);
        res.json({ success: true, result });

    } catch (error) {
        console.error(`Error making call on session ${session}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// RESTORE SESSIONS
// ============================================================================
const restoreSessions = async () => {
    console.log('🔄 [Restore] Checking for persisted sessions...');
    const stored = loadSessionsFromFile();
    const sessionNames = Object.keys(stored);

    if (sessionNames.length === 0) {
        console.log('ℹ️ [Restore] No sessions found in storage.');
        return;
    }

    console.log(`ℹ️ [Restore] Found ${sessionNames.length} sessions to restore.`);

    for (const name of sessionNames) {
        const data = stored[name];
        if (sessions.has(name)) continue;

        console.log(`🚀 [Restore] Starting session: ${name}`);
        startWppSession(name, data.webhookUrl).catch(err => {
            console.error(`❌ [Restore] Failed to restore session ${name}:`, err);
        });

        await new Promise(r => setTimeout(r, 5000));
    }
};

restoreSessions();

app.listen(PORT, () => {
    console.log(`WPP Service running on port ${PORT}`);
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
const cleanupAllSessions = async () => {
    console.log('Shutting down... Cleaning all sessions.');
    for (const session of sessions.keys()) {
        await termitateSession(session);
    }
    process.exit(0);
};

process.on('SIGINT', cleanupAllSessions);
process.on('SIGTERM', cleanupAllSessions);
