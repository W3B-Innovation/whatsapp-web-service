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

    // IDs de estados suelen ser muy largos, PERO los grupos (@g.us) también.
    // Ignorar esta validación si es un grupo.
    const fromId = message.from ? message.from.replace(/@.*$/g, '') : '';
    const isGroup = message.from && message.from.includes('@g.us');

    if (!isGroup && fromId.length > 15) return true;

    return false;
}

/**
 * Detecta si un phoneId es un LID (Local Identifier)
 * Los LIDs tienen formato: 86299532898535:22@lid o similar
 */
function isLID(phoneId) {
    return phoneId && (phoneId.includes('@lid') || phoneId.includes(':'));
}

/**
 * Intenta extraer el número real de teléfono desde un LID
 * LID formato: 86299532898535:22@lid o 224206520340679@lid
 * Puede contener un número de teléfono codificado
 */
function extractPhoneFromLID(lidString) {
    if (!lidString) return null;

    // Remover sufijos
    let cleaned = lidString.replace(/@lid|@c\.us|@s\.whatsapp\.net/g, '');

    // Si tiene formato "numero:algo", tomar solo la parte antes de ":"
    if (cleaned.includes(':')) {
        const parts = cleaned.split(':');
        cleaned = parts[0];
    }

    // El primer dígito y los siguientes podrían ser el número real
    // Ejemplo: 86299532898535 podría ser un LID que esconde 529953289853
    // Los LIDs suelen empezar con el código de país

    // Si el número tiene más de 15 dígitos, es probablemente un LID puro (no contiene número real)
    if (cleaned.length > 15) {
        console.log(`[LID] Very long ID detected: ${cleaned} - likely pure LID without phone number`);
        return null;
    }

    return cleaned;
}

/**
 * Extrae el número de teléfono limpio de un mensaje
 */
function extractPhoneNumber(message) {
    let phoneId = null;

    // Determinar el ID correcto según la dirección del mensaje
    if (message.fromMe) {
        // Mensaje saliente: usar 'to' (generalmente el ID del chat/grupo/usuario destino)
        // OJO: message.to es el destinatario real. message.chatId a veces es el LID del usuario propio si lo manda desde otro dispositivo.
        phoneId = message.to || message.chatId;
    } else {
        // Mensaje entrante: usar 'from'
        phoneId = message.from || message.chatId;
    }

    if (!phoneId) return null;

    // Si es grupo, NO extraer el número del participante aquí.
    // Queremos que el ID de la "Conversación" sea el ID del Grupo.
    // El participante se maneja por separado para el contactName.

    // MEJORA: Detectar si es un LID
    if (isLID(phoneId)) {
        console.log(`[LID] Detected LID format: ${phoneId}`);

        // Intentar extraer número del LID
        const extractedPhone = extractPhoneFromLID(phoneId);

        if (extractedPhone && isValidPhoneNumber(extractedPhone)) {
            console.log(`[LID] Extracted valid phone from LID: ${extractedPhone}`);
            return extractedPhone;
        }

        // Si no pudimos extraer número válido del LID, usar el LID limpio como ID
        // (esto es para contactos comerciales que realmente no tienen número de teléfono tradicional)
        const lidCleaned = phoneId.replace(/@lid|@c\.us|@s\.whatsapp\.net|@broadcast/g, '').split(':')[0];
        console.log(`[LID] Using cleaned LID as identifier: ${lidCleaned}`);
        return lidCleaned;
    }

    // Limpiar el ID (Soporte para @lid que es el nuevo formato de ID privado)
    // También @g.us y otros
    const cleanPhone = phoneId.replace(/@c.us|@g.us|@s.whatsapp.net|@broadcast|@lid/g, '');

    // Validar
    if (!isValidPhoneNumber(cleanPhone)) {
        // Si es un grupo, a veces el ID es largo y válido, intentemos confiar si tiene @g.us el original
        if (phoneId.includes('@g.us')) return cleanPhone;

        console.log(`[Filter] Invalid phone number: ${cleanPhone} from ${phoneId}`);
        return null;
    }

    return cleanPhone;
}

/**
 * Obtiene el nombre del contacto
 * Intenta múltiples fuentes en orden de preferencia
 */
async function getContactName(client, phoneId) {
    try {
        const contact = await client.getContact(phoneId);

        if (!contact) {
            console.warn(`[ContactName] Contact not found for ${phoneId}`);
            return null;
        }

        // Intentar diferentes fuentes del nombre en orden de preferencia
        const name = contact.name ||           // Nombre guardado en agenda
            contact.pushname ||         // Nombre de WhatsApp del usuario
            contact.verifiedName ||     // Nombre verificado (business)
            contact.shortName ||        // Nombre corto
            contact.formattedName ||    // Nombre formateado
            null;

        if (name) {
            console.log(`[ContactName] ✓ Found name "${name}" for ${phoneId}`);
        } else {
            console.warn(`[ContactName] No name found for ${phoneId}`);
        }

        return name;
    } catch (e) {
        // Si el error es "detached Frame", propagarlo para que pueda reiniciar la sesión
        if (e.message && e.message.includes('detached Frame')) throw e;

        console.warn(`[ContactName] Error getting contact name for ${phoneId}:`, e.message);
        return null;
    }
}

/**
 * Intenta obtener el número de teléfono REAL de un contacto
 * Útil para LIDs donde el ID no es el número de teléfono verdadero
 * Usa getPnLidEntry para LIDs y análisis profundo de Contact para otros casos
 */
async function getRealPhoneNumber(client, phoneId) {
    try {
        // OPCIÓN 1: Usar getPnLidEntry (más confiable para LIDs)
        if (isLID(phoneId)) {
            try {
                console.log(`[PnLid] Attempting getPnLidEntry for LID: ${phoneId}`);
                const result = await client.getPnLidEntry(phoneId);

                if (result && result.phoneNumber) {
                    // phoneNumber puede ser un objeto con _serialized o id, o un string
                    const phoneValue = typeof result.phoneNumber === 'string'
                        ? result.phoneNumber
                        : (result.phoneNumber._serialized || result.phoneNumber.id);

                    if (phoneValue && typeof phoneValue === 'string') {
                        const cleaned = phoneValue.replace(/@c\.us|@g\.us|@s\.whatsapp\.net|@lid|@broadcast/g, '');

                        if (isValidPhoneNumber(cleaned)) {
                            console.log(`[PnLid] ✓ Found phone number via getPnLidEntry: ${cleaned} for LID: ${phoneId}`);
                            return cleaned;
                        }
                    }
                }
            } catch (lidError) {
                console.warn(`[PnLid] getPnLidEntry failed for ${phoneId}, trying fallback methods...`, lidError.message);
            }
        }

        // OPCIÓN 2: Usar getContact (fallback o para IDs normales)
        const contact = await client.getContact(phoneId);

        if (contact) {
            // Intentar diferentes fuentes del número en orden de confiabilidad
            const possibleNumbers = [
                contact.number,           // Número directo si está disponible
                contact.id?.user,         // El campo 'user' en el ID generalmente tiene el número
                contact.id?._serialized,  // ID serializado completo
                contact.id                // ID como string
            ];

            for (const realNumber of possibleNumbers) {
                if (realNumber && typeof realNumber === 'string') {
                    // Limpiar y validar
                    const cleaned = realNumber.replace(/@c\.us|@g\.us|@s\.whatsapp\.net|@lid|@broadcast/g, '').split(':')[0];

                    if (isValidPhoneNumber(cleaned)) {
                        console.log(`[RealPhone] ✓ Found real number: ${cleaned} for ID: ${phoneId}`);
                        return cleaned;
                    }
                }
            }

            // Log del contacto para debugging si no pudimos extraer el número
            console.warn(`[RealPhone] Contact found but no valid number extracted. Contact structure:`, {
                id: contact.id,
                number: contact.number,
                hasName: !!contact.name,
                hasPushname: !!contact.pushname
            });
        }

        console.warn(`[RealPhone] Could not extract real phone number for ${phoneId}`);
        return null;
    } catch (e) {
        // Si el error es "detached Frame", propagarlo
        if (e.message && e.message.includes('detached Frame')) throw e;

        console.warn(`[RealPhone] Error getting real phone for ${phoneId}:`, e.message);
        return null;
    }
}


/**
 * Obtiene información completa del contacto (nombre y número de teléfono)
 * Más eficiente que llamar getContactName y getRealPhoneNumber por separado
 * @returns {Object} { name: string|null, phoneNumber: string|null, contact: Object }
 */
async function getContactInfo(client, phoneId) {
    try {
        let phoneNumber = null;
        let contact = null;

        // Para LIDs, intentar primero getPnLidEntry que da toda la info
        if (isLID(phoneId)) {
            try {
                console.log(`[ContactInfo] 🔍 Attempting getPnLidEntry for LID: ${phoneId}`);
                console.log(`[ContactInfo] 🔍 getPnLidEntry exists:`, typeof client.getPnLidEntry);

                const result = await client.getPnLidEntry(phoneId);

                console.log(`[ContactInfo] 🔍 getPnLidEntry result:`, JSON.stringify(result, null, 2));

                if (result) {
                    // Extraer número de teléfono del resultado
                    if (result.phoneNumber) {
                        // phoneNumber puede ser un objeto con _serialized o id, o un string
                        const phoneValue = typeof result.phoneNumber === 'string'
                            ? result.phoneNumber
                            : (result.phoneNumber._serialized || result.phoneNumber.id);

                        if (phoneValue && typeof phoneValue === 'string') {
                            const cleaned = phoneValue.replace(/@c\.us|@g\.us|@s\.whatsapp\.net|@lid|@broadcast/g, '');
                            if (isValidPhoneNumber(cleaned)) {
                                phoneNumber = cleaned;
                                console.log(`[ContactInfo] ✓ Phone from getPnLidEntry: ${phoneNumber}`);
                            }
                        }
                    }

                    // Si hay contactInfo en el resultado, puede tener el nombre
                    if (result.contactInfo) {
                        contact = result.contactInfo;
                    }
                }
            } catch (lidError) {
                // Propagar error crítico
                if (lidError.message && lidError.message.includes('detached Frame')) throw lidError;

                console.error(`[ContactInfo] ❌ getPnLidEntry failed for ${phoneId}:`, lidError.message);
                console.error(`[ContactInfo] ❌ Full error:`, lidError);
            }
        }

        // Obtener el contacto si no lo tenemos aún
        if (!contact) {
            contact = await client.getContact(phoneId);
        }

        if (!contact) {
            console.warn(`[ContactInfo] Contact not found for ${phoneId}`);
            return { name: null, phoneNumber, contact: null };
        }

        // Extraer nombre
        const name = contact.name ||
            contact.pushname ||
            contact.verifiedName ||
            contact.shortName ||
            contact.formattedName ||
            null;

        // Extraer número de teléfono si no lo obtuvimos antes
        if (!phoneNumber) {
            // DEBUG: Mostrar todos los campos disponibles
            console.log(`[ContactInfo] 🔍 DEBUG for ${phoneId}:`);
            console.log(`  - contact.formattedName: "${contact.formattedName}"`);
            console.log(`  - contact.number: "${contact.number}"`);
            console.log(`  - contact.id?.user: "${contact.id?.user}"`);
            console.log(`  - contact.id?._serialized: "${contact.id?._serialized}"`);

            // Para LIDs, formattedName contiene el número real (ej: "+52 1 951 273 5199") 
            // mientras que id.user contiene el identificador del LID
            const possibleNumbers = isLID(phoneId) ? [
                contact.formattedName,  // ← PRIORIDAD para LIDs: número real formateado
                contact.number,
                contact.id?.user,      // Para LIDs esto es el ID, no el número
                contact.id?._serialized,
                contact.id
            ] : [
                contact.number,         // Para contactos normales, priorizar number
                contact.formattedName,
                contact.id?.user,
                contact.id?._serialized,
                contact.id
            ];

            for (const num of possibleNumbers) {
                if (num && typeof num === 'string') {
                    // Limpiar el número: remover +, espacios, sufijos de WhatsApp
                    const cleaned = num
                        .replace(/\+/g, '')  // Remover +
                        .replace(/\s/g, '')  // Remover espacios
                        .replace(/@c\.us|@g\.us|@s\.whatsapp\.net|@lid|@broadcast/g, '')
                        .split(':')[0];

                    console.log(`[ContactInfo] 🔍 Trying "${num}" → cleaned: "${cleaned}" → valid: ${isValidPhoneNumber(cleaned)}`);

                    if (isValidPhoneNumber(cleaned)) {
                        phoneNumber = cleaned;
                        const source = num === contact.formattedName ? 'formattedName' :
                            num === contact.number ? 'contact.number' : 'id';
                        console.log(`[ContactInfo] ✓ Found phone from ${source}: ${phoneNumber}`);
                        break;
                    }
                }
            }
        }

        console.log(`[ContactInfo] ✓ Retrieved info for ${phoneId}: name="${name}", phone="${phoneNumber}"`);

        return {
            name,
            phoneNumber,
            contact,
            isBusiness: contact.isBusiness || false,
            isMyContact: contact.isMyContact || false
        };
    } catch (e) {
        // Si el error es "detached Frame", propagarlo
        if (e.message && e.message.includes('detached Frame')) throw e;

        console.warn(`[ContactInfo] Error getting contact info for ${phoneId}:`, e.message);
        return { name: null, phoneNumber: null, contact: null };
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
        if (e.message && e.message.includes('detached Frame')) throw e;

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

/**
 * Cierra una sesión sin eliminar tokens (para uso en shutdown)
 * Mantiene la persistencia para que la sesión pueda restaurarse
 */
const closeSession = async (session) => {
    console.log(`[Close] Closing session: ${session} (preserving tokens)`);
    const data = sessions.get(session);

    if (data && data.client) {
        try {
            await data.client.close();
            console.log(`[Close] Client closed for ${session}`);
        } catch (e) {
            console.error(`[Close] Error closing client for ${session}:`, e.message);
        }
    }

    if (data && data.pid) {
        try {
            console.log(`[Close] Killing browser process tree for ${session} (PID: ${data.pid})...`);
            await new Promise((resolve) => {
                kill(data.pid, 'SIGKILL', (err) => {
                    if (err) console.warn(`[Close] Kill failed for ${data.pid}:`, err.message);
                    resolve();
                });
            });
        } catch (e) {
            // Ignore error
        }
    }

    // Solo limpiar browser data temporal, NO los tokens
    if (data && data.browserPath) {
        try {
            if (fs.existsSync(data.browserPath)) {
                fs.rmSync(data.browserPath, { recursive: true, force: true });
                console.log(`[Close] Browser data cleaned for ${session}`);
            }
        } catch (e) {
            console.warn(`[Close] Could not delete browser data: ${e.message}`);
        }
    }

    // Remover de memoria pero MANTENER en sessions.json y tokens/
    sessions.delete(session);
    console.log(`[Close] Session ${session} closed (tokens preserved)`);
};

/**
 * Termina y ELIMINA completamente una sesión (tokens incluidos)
 * Solo se usa cuando el usuario elimina explícitamente la sesión desde el CRM
 */
const terminateAndDeleteSession = async (session) => {
    console.log(`[Terminate] Completely deleting session: ${session}`);
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

    // ELIMINAR tokens (esto requiere volver a escanear QR)
    await attemptCleanup(path.join(TOKENS_DIR, session));

    if (data && data.browserPath) {
        await attemptCleanup(data.browserPath);
    } else {
        await attemptCleanup(path.join(BROWSER_DATA_DIR, session));
    }

    sessions.delete(session);
    removeSessionFromFile(session);
    console.log(`[Terminate] Session ${session} completely deleted`);
};

// Mantener alias para compatibilidad con código existente
const termitateSession = terminateAndDeleteSession;

// ============================================================================
// SESSION RECOVERY
// ============================================================================
const restartingSessions = new Set();

const restartSession = async (sessionName, webhookUrl) => {
    if (restartingSessions.has(sessionName)) {
        console.log(`[Restart] Session ${sessionName} already restarting...`);
        return;
    }
    restartingSessions.add(sessionName);

    try {
        console.warn(`[Restart] 🔴 CRITICAL: Restarting session ${sessionName} due to browser error...`);

        // 1. Cerrar sesión actual (preservando tokens)
        await closeSession(sessionName);

        // 2. Esperar un momento para asegurar limpieza
        await new Promise(r => setTimeout(r, 5000));

        // 3. Iniciar nueva sesión
        console.log(`[Restart] 🚀 Launching new process for ${sessionName}...`);
        startWppSession(sessionName, webhookUrl);

    } catch (e) {
        console.error(`[Restart] ❌ Failed to restart session ${sessionName}:`, e);
    } finally {
        // Remover del set después de un tiempo prudencial para evitar bucles rápidos
        setTimeout(() => {
            restartingSessions.delete(sessionName);
        }, 20000); // 20 segundos de cool-down
    }
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

        // Garbage collection eliminado - ahora reutilizamos las carpetas existentes
        // para permitir persistencia de sesiones


        // Usar ruta estándar para el browser data (sin timestamp único)
        // Esto permite que WPPConnect reutilice la sesión existente
        const browserPath = path.join(BROWSER_DATA_DIR, sessionName);
        sessionData.browserPath = browserPath;

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
                userDataDir: browserPath, // Usar ruta estándar sin timestamp
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
                let phoneNumber = extractPhoneNumber(message);
                if (!phoneNumber) {
                    console.log(`[Filter] Could not extract valid phone number from message`);
                    return;
                }

                // 5.5 MEJORA: Si detectamos un LID, intentar obtener el número real
                const originalPhoneId = message.fromMe ? (message.to || message.chatId) : (message.from || message.chatId);
                if (originalPhoneId && isLID(originalPhoneId)) {
                    console.log(`[LID] Attempting to get real phone number for LID: ${originalPhoneId}`);
                    const realPhone = await getRealPhoneNumber(client, originalPhoneId);
                    if (realPhone && realPhone !== phoneNumber) {
                        console.log(`[LID] Replaced LID-based phone ${phoneNumber} with real phone: ${realPhone}`);
                        phoneNumber = realPhone;
                    }
                }

                console.log(`[Valid] Processing message from phone: ${phoneNumber}`);
                console.log(`[Debug] Message body:`, message.body);
                console.log(`[Debug] Message has mentionedIds:`, message.mentionedIds || 'None');

                // Procesar menciones - Intentar de dos formas:
                // 1. Usando mentionedIds si está disponible
                // 2. Parseando el body del mensaje si mentionedIds está vacío

                let mentionsToProcess = [];

                if (message.mentionedIds && message.mentionedIds.length > 0) {
                    mentionsToProcess = message.mentionedIds;
                    console.log(`[Mentions] Using mentionedIds field:`, mentionsToProcess);
                } else if (message.body && message.body.includes('@')) {
                    // Detectar menciones en el body (formato: @22660348166233)
                    const mentionPattern = /@(\d{10,})/g;
                    const matches = [...message.body.matchAll(mentionPattern)];
                    if (matches.length > 0) {
                        mentionsToProcess = matches.map(m => m[1]); // Solo los números
                        console.log(`[Mentions] Extracted from body:`, mentionsToProcess);
                    }
                }

                if (mentionsToProcess.length > 0) {
                    console.log(`[Mentions] Processing ${mentionsToProcess.length} mentions:`, mentionsToProcess);

                    for (const mentionId of mentionsToProcess) {
                        try {
                            // Limpiar el ID primero (por si viene con @c.us, @lid, etc.)
                            const cleanId = mentionId.replace(/@c\.us|@g\.us|@s\.whatsapp\.net|@lid/g, '');

                            // Intentar obtener el nombre con diferentes formatos de ID
                            let mentionedName = null;

                            // Intento 1: ID original
                            mentionedName = await getContactName(client, mentionId);

                            // Intento 2: Si falla y el ID no tiene @, probar con @c.us
                            if (!mentionedName && !mentionId.includes('@')) {
                                mentionedName = await getContactName(client, `${cleanId}@c.us`);
                            }

                            // Intento 3: Si aún no hay nombre, probar con @lid
                            if (!mentionedName) {
                                mentionedName = await getContactName(client, `${cleanId}@lid`);
                            }

                            // Fallback: Si no encontramos nombre, usar formato limpio del número
                            if (!mentionedName) {
                                // Para números largos, tomar los últimos 10 dígitos
                                mentionedName = cleanId.length > 10 ? cleanId.slice(-10) : cleanId;
                                console.log(`[Mentions] No name found for ${mentionId}, using fallback: ${mentionedName}`);
                            } else {
                                console.log(`[Mentions] Resolved ${mentionId} to: ${mentionedName}`);
                            }

                            // Reemplazar en el cuerpo del mensaje
                            const mentionRegex = new RegExp(`@${cleanId}`, 'g');
                            message.body = message.body.replace(mentionRegex, `@${mentionedName}`);
                        } catch (err) {
                            console.warn(`[Mentions] Error resolving mention for ${mentionId}:`, err);
                        }
                    }
                }

                // 6. DETERMINAR SI ES GRUPO
                const isGroup = isGroupMessage(message);
                let contactName = null;
                let groupName = null;
                let senderName = null; // Nuevo: para identificar quién envió el mensaje específico

                if (isGroup) {
                    // Obtener información del grupo
                    const rawGroupId = message.fromMe ? (message.to || message.chatId) : (message.from || message.chatId);
                    const groupInfo = await getGroupInfo(client, rawGroupId);
                    groupName = groupInfo.name || "Grupo";

                    // Para grupos: contactName es el nombre del grupo (para agrupar conversación)
                    contactName = groupName;

                    // Para grupos: senderName es quien envió el mensaje
                    const participantId = message.author || message.sender?.id || message.participant;

                    if (message.fromMe) {
                        // Si fui yo (desde el celular o web), poner "Tú"
                        senderName = 'Tú';
                    } else if (participantId) {
                        const pName = await getContactName(client, participantId);
                        // Limpiar ID de LIDs que tienen formato 12345:22@lid
                        const cleanPId = participantId.replace(/(:.*$|@.*$)/g, '');
                        // Si no tiene nombre, usar el número/ID limpio
                        senderName = pName || cleanPId;
                    } else {
                        senderName = 'Unknown';
                    }

                    console.log(`[Group] Group: "${groupName}", sender: ${senderName} (Participant ID: ${participantId})`);
                } else {
                    // Mensaje individual
                    const targetId = message.fromMe ? (message.to || message.chatId) : (message.from || message.chatId);
                    const name = await getContactName(client, targetId);
                    // Si no hay nombre, usar el número limpio
                    contactName = name || phoneNumber;

                    // Asignar senderName: "Tú" si es saliente, nombre del contacto si es entrante
                    if (message.fromMe) {
                        senderName = 'Tú';
                    } else {
                        senderName = contactName;
                    }

                    console.log(`[Individual] Message ${message.fromMe ? 'TO' : 'FROM'} contact: ${contactName}, sender: ${senderName} (ID: ${targetId})`);
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

                const mimetypeMap = { image: 'image/jpeg', video: 'video/mp4', ptt: 'audio/ogg', audio: 'audio/ogg', sticker: 'image/webp', document: 'application/octet-stream' };
                const mimetype = (message.mimetype || '').trim() || (mediaData && mimetypeMap[message.type]) || '';

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
                        senderName: senderName,
                        isGroup: isGroup,
                        groupName: groupName,
                        sender: message.sender || {},
                        mediaData: mediaData || null,
                        mimetype: mimetype
                    }
                });

                console.log(`[Webhook] Sending message to webhook - Phone: ${phoneNumber}, IsGroup: ${isGroup}, Group: ${groupName || 'N/A'}`);
                sendWebhook(webhookUrl, 'on_message', payload);

            } catch (error) {
                console.error(`[Error] Processing message ${message.id}:`, error);

                // Detectar error crítico "detached Frame" y reiniciar sesión
                if (error.message && error.message.includes('detached Frame')) {
                    console.error(`[CRITICAL] Browser frame detached for session ${sessionName}. Initiating restart...`);
                    restartSession(sessionName, webhookUrl);
                }
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

// ============================================================================
// CONTACT INFORMATION ENDPOINT
// ============================================================================
/**
 * Endpoint para obtener información de un contacto (nombre y número de teléfono)
 * Útil para contactos no registrados o con formato LID
 */
app.post('/api/session/:session/contact-info', async (req, res) => {
    const { session } = req.params;
    const { contactId } = req.body;

    if (!contactId) {
        return res.status(400).json({ error: 'contactId is required' });
    }

    const sessionData = sessions.get(session);
    if (!sessionData || !sessionData.client) {
        return res.status(404).json({ error: 'Session not found or not connected' });
    }

    try {
        console.log(`[ContactInfo API] Getting info for ${contactId} on session ${session}`);

        const info = await getContactInfo(sessionData.client, contactId);

        console.log(`[ContactInfo API] ✓ Retrieved info:`, info);

        res.json({
            success: true,
            contactId,
            name: info.name,
            phoneNumber: info.phoneNumber,
            isBusiness: info.isBusiness,
            isMyContact: info.isMyContact
        });
    } catch (error) {
        console.error(`[ContactInfo API] Error getting contact info for ${contactId}:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            contactId
        });
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
    console.log('🛑 [Shutdown] Gracefully shutting down microservice...');
    console.log(`🔄 [Shutdown] Closing ${sessions.size} active sessions (preserving tokens for restart)...`);

    for (const session of sessions.keys()) {
        await closeSession(session); // Usar closeSession en vez de termitateSession
    }

    console.log('✅ [Shutdown] All sessions closed. Tokens and sessions.json preserved.');
    console.log('💡 [Shutdown] Sessions will automatically restore on next startup.');
    process.exit(0);
};

process.on('SIGINT', cleanupAllSessions);
process.on('SIGTERM', cleanupAllSessions);

