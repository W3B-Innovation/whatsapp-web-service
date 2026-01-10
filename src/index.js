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
const SECRET_KEY = process.env.SECRET_KEY || 'THISISMYSECURETOKEN'; // Use a default or env
const SESSION_LIMIT = parseInt(process.env.SESSION_LIMIT || '5', 10);

// Basic directories for tokens and user data
const TOKENS_DIR = path.resolve(process.cwd(), 'tokens');
const BROWSER_DATA_DIR = path.resolve(process.cwd(), '.wpp_browser_data');

if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });
if (!fs.existsSync(BROWSER_DATA_DIR)) fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });

// ============================================================================
// STATE STORE
// ============================================================================
// Map<sessionId, { client: WppClient, status: string, webhookUrl: string, qr: string|null }>
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

    // Attempt to close client if it exists
    if (data && data.client) {
        try {
            await data.client.close();
        } catch (e) {
            console.error('Error closing client:', e.message);
        }
    }

    // FORCE KILL PID if needed (Stubborn processes)
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

    // Small delay to allow process to release locks
    await new Promise(resolve => setTimeout(resolve, 3000));

    const attemptCleanup = async (pathStr) => {
        // Try up to 10 times (10 seconds)
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

    // Clean up the specific browser path if we have it
    if (data && data.browserPath) {
        await attemptCleanup(data.browserPath);
    } else {
        // Fallback to standard path
        await attemptCleanup(path.join(BROWSER_DATA_DIR, session));
    }

    sessions.delete(session);
    removeSessionFromFile(session);
};

const startWppSession = async (sessionName, webhookUrl, res = null) => {
    const serviceStartTime = Math.floor(Date.now() / 1000);
    // Check if session limits reached (if strictly a new session)
    if (!sessions.has(sessionName) && sessions.size >= SESSION_LIMIT) {
        const error = `Session limit of ${SESSION_LIMIT} reached.`;
        if (res) return res.status(403).json({ error });
        return;
    }

    // Update session store immediately
    if (!sessions.has(sessionName)) {
        sessions.set(sessionName, {
            client: null,
            status: 'INITIALIZING',
            webhookUrl,
            qr: null
        });
    }

    const sessionData = sessions.get(sessionName);
    sessionData.webhookUrl = webhookUrl; // Update webhook if provided

    // PERSISTENCE: Save session info so it survives restarts
    saveSessionToFile(sessionName, webhookUrl);

    // Response promise handling for the initial HTTP request
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

        // 1. GARBAGE COLLECTION
        // Scan for ANY old folders belonging to this session name (e.g. nuevasesion-1736...)
        // and delete them. This cleans up space from previous crashed/locked attempts.
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

        // 2. SETUP UNIQUE SESSION
        const uniqueId = `${sessionName}-${Date.now()}`;
        const uniqueBrowserPath = path.join(BROWSER_DATA_DIR, uniqueId);

        // Store path for cleanup later
        sessionData.browserPath = uniqueBrowserPath;

        // Try to clean up any OLD standard folders for this session name just in case
        // This is "best effort" garbage collection
        const standardPath = path.join(BROWSER_DATA_DIR, sessionName);
        if (fs.existsSync(standardPath)) {
            try {
                // Don't wait on this, just fire and forget or quick attempt
                fs.rmSync(standardPath, { recursive: true, force: true });
            } catch (e) { /* ignore EBUSY on legacy folder */ }
        }

        // Create the client
        const client = await wppconnect.create({
            session: sessionName,
            catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
                console.log(`QR received for ${sessionName}, attempt ${attempts}`);
                sessionData.qr = base64Qr;
                sessionData.status = 'WAITING_QR';

                // This is the CRITICAL part: return the QR to the HTTP request
                sendResponse({
                    status: 'QR_GENERATED',
                    qr: base64Qr,
                    attempts
                });

                // Auto-cleanup timer if not connected in 60s
                if (attempts === 1) { // Set timeout only on first attempt
                    setTimeout(async () => {
                        const currentSession = sessions.get(sessionName);
                        // Check if still waiting for QR or not connected
                        if (currentSession && (currentSession.status === 'WAITING_QR' || currentSession.status === 'INITIALIZING')) {
                            console.log(`Session ${sessionName} timed out (QR not scanned). Cleaning up...`);
                            await termitateSession(sessionName);
                            // Notify webhook of expiration
                            sendWebhook(webhookUrl, 'status_change', { session: sessionName, status: 'qr_expired' });
                        }
                    }, 60000); // 60 seconds
                }
            },
            statusFind: (statusSession, session) => {
                console.log(`Status change for ${sessionName}: ${statusSession}`);
                sessionData.status = statusSession;

                // Webhook updates
                sendWebhook(webhookUrl, 'status_change', { session: sessionName, status: statusSession });

                if (statusSession === 'inChat' || statusSession === 'isLogged') {
                    sessionData.qr = null; // Clear QR once connected
                }
            },
            headless: true,
            devtools: false,
            useChrome: true, // Back to using Chrome as per library default for better compatibility
            debug: false,
            logQR: false,
            disableWelcome: true,
            updatesLog: true,
            autoClose: 60000, // Library default is 60s
            waitForLogin: true, // Wait for login to be fully ready
            whatsappVersion: '2.3000.10305x', // Recommended version from wppconnect
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

        // --- NEW: Capture PID for Force Kill ---
        try {
            // wppconnect client exposes page, page exposes browser, browser exposes process
            // This might differ by version, so we code defensively
            let browser = null;
            if (client.page && client.page.browser) browser = client.page.browser();
            else if (client.browser) browser = client.browser;

            if (browser) {
                const proc = browser.process();
                if (proc) {
                    sessionData.pid = proc.pid;
                    console.log(`Captured PID for ${sessionName}: ${proc.pid}`);
                } else {
                    console.warn(`Could not get process from browser for ${sessionName}`);
                }
            } else {
                console.warn(`Could not find browser instance on client object for ${sessionName}`);
            }
        } catch (e) { console.error('Could not capture browser PID:', e); }
        // ---------------------------------------

        // Message Hook
        client.onAnyMessage(async (message) => {
            // Normalize timestamp to seconds if needed (WPPConnect sometimes uses MS)
            let ts = message.timestamp;
            if (ts && ts > 1000000000000) {
                ts = Math.floor(ts / 1000);
            }

            console.log(`[DEBUG] Msg: ${message.id} | Type: ${message.type} | TS: ${ts} | ServiceStart: ${serviceStartTime} | Diff: ${ts - serviceStartTime}s | Body: ${message.body ? message.body.substring(0, 20) : 'EMPTY'}`);

            // Ignore messages older than service start time (prevent history flood)
            // Also ignore if timestamp is missing
            if (!ts || ts < serviceStartTime) {
                console.log(`[Filter] Skipping old message: ${ts} < ${serviceStartTime} (Diff: ${serviceStartTime - ts}s)`);
                return;
            }

            // Whitelist allowed message types to avoid system messages (e2e, protocol, etc.)
            const validTypes = ['chat', 'image', 'video', 'ptt', 'audio', 'sticker', 'document', 'vcard', 'location', 'multi_vcard'];
            if (!validTypes.includes(message.type)) {
                console.log(`[Filter] Skipping ignored message type: ${message.type}`);
                return;
            }

            // Filter empty chat messages
            if (message.type === 'chat' && !message.body) {
                console.log(`[Filter] Skipping empty chat message`);
                return;
            }

            // Sanitize body for media types
            let cleanBody = message.body;
            let mediaData = null;

            const mediaTypes = ['image', 'video', 'ptt', 'audio', 'sticker', 'document', 'vcard', 'location'];

            if (mediaTypes.includes(message.type)) {
                console.log(`[Media] Detected media message: ${message.type}`);
                cleanBody = `[${message.type}]`; // Default placeholder

                // Specifically for image/document/audio/sticker, try to download content
                if (['image', 'video', 'ptt', 'audio', 'sticker', 'document'].includes(message.type)) {
                    try {
                        console.log(`[Media] Downloading content for ${message.id}...`);
                        // WPPConnect returns a Buffer OR a Base64 string depending on version
                        const result = await client.downloadMedia(message);
                        if (result) {
                            if (Buffer.isBuffer(result)) {
                                mediaData = result.toString('base64');
                            } else if (typeof result === 'string') {
                                // If it's a data URI (data:image/jpeg;base64,...), strip the prefix
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

            // Safety check for text length
            if (!mediaData && cleanBody && cleanBody.length > 2000) {
                cleanBody = '[Contenido largo/Media]';
            }

            // Helper to remove undefined values for Firestore
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
                    sender: message.sender || {},
                    mediaData: mediaData || null,
                    mimetype: message.mimetype || ''
                }
            });

            sendWebhook(webhookUrl, 'on_message', payload);
        });

        // If we are here and response hasn't been sent (e.g. session was already logged in), send success
        // This happens if catchQR is never called because tokens are valid
        if (!responseSent) {
            // We can ensure connection state check here
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

// 1. Start Session & Get QR
app.post('/api/session/start-session', async (req, res) => {
    const { session, webhook } = req.body;
    if (!session) return res.status(400).json({ error: 'Session name is required' });

    // If session exists and is connected, return that
    const existing = sessions.get(session);
    if (existing && existing.client) {
        try {
            const state = await existing.client.getConnectionState();
            if (state === 'CONNECTED') {
                return res.json({ status: 'ALREADY_CONNECTED', message: 'Session is active' });
            } else {
                // Not connected? Kill it to start fresh
                console.log(`Session ${session} exists but is state ${state}. Terminating to restart.`);
                await termitateSession(session);
            }
        } catch (e) {
            await termitateSession(session);
        }
    } else if (existing) {
        // Exists in map but no client? (e.g. INITIALIZING stuck)
        await termitateSession(session);
    }

    // Also check directory existence to be sure no leftover locks
    try {
        if (fs.existsSync(path.join(BROWSER_DATA_DIR, session))) {
            // We can't easily rm -rf if process is running, but terminateSession should have killed it.
            // Rely on startWppSession to handle it or error out.
        }
    } catch (e) { }

    // Start new flow
    // Note: startWppSession handles the response (res) inside catchQR or on success
    startWppSession(session, webhook, res);
});

// 2. Get All Sessions Info
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

// 3. Get Specific Session Status
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

// 4. Terminate Session
app.post('/api/session/:session/terminate', async (req, res) => {
    const { session } = req.params;
    await termitateSession(session);
    res.json({ success: true });
});

// 5. Send Message
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

        // Basic cleanup: allow only digits, @, -
        destination = destination.replace(/[^\d@\-]/g, '');

        // If it doesn't have a suffix, append @c.us (assuming individual chat)
        if (!destination.includes('@')) {
            destination = `${destination}@c.us`;
        }

        console.log(`[Send] Processing send request for ${destination} on session ${session}`);

        // OPTIONAL: Validar existencia del número para obtener el ID real (corrige problemas de 521 vs 52 en MX)
        try {
            const result = await sessionData.client.checkNumberStatus(destination);
            if (result && result.numberExists && result.id && result.id._serialized) {
                console.log(`[Send] Resolved ${destination} to canonical ID: ${result.id._serialized}`);
                destination = result.id._serialized;
            } else if (result && !result.numberExists) {
                console.warn(`[Send] Warning: WhatsApp says ${destination} does not exist.`);
                // We might still try to send or return error. Let's return error to be safe/clear.
                return res.status(400).json({ error: 'Number does not exist on WhatsApp', details: result });
            }
        } catch (e) {
            console.warn(`[Send] checkNumberStatus failed for ${destination}: ${e.message}. Attempting to send using raw JID.`);
            // Fallback: Si falla el chequeo (timeout, etc), intentamos enviar con el JID construido manualmente
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
        // Skip if somehow already running (shouldn't happen on fresh start)
        if (sessions.has(name)) continue;

        console.log(`🚀 [Restore] Starting session: ${name}`);
        // We do NOT await the full connection here, but we insert a stagger delay
        // so we don't hammer the CPU launching 5 browsers at once.
        startWppSession(name, data.webhookUrl).catch(err => {
            console.error(`❌ [Restore] Failed to restore session ${name}:`, err);
        });

        // Wait a few seconds between launches
        await new Promise(r => setTimeout(r, 5000));
    }
};

// Start restoration process
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
