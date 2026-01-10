require('dotenv').config();

const fetch = require('node-fetch');
const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ============================================================================
// CONFIGURACIÓN Y VALIDACIÓN
// ============================================================================

const CRM_SYNC_URL = process.env.CRM_SYNC_URL;
const CRM_SYNC_TOKEN = process.env.CRM_SYNC_TOKEN;
const CRM_SESSIONS_URL = process.env.CRM_SESSIONS_URL;
const CRM_QR_URL = process.env.CRM_QR_URL || (CRM_SYNC_URL ? CRM_SYNC_URL.replace('/web-sync', '/web-sync/qr') : null);

console.log('🔧 [CONFIG] CRM_SYNC_URL:', CRM_SYNC_URL);
console.log('🔧 [CONFIG] CRM_QR_URL:', CRM_QR_URL);

const PORT = process.env.PORT || 4000;
const HTTP_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT || '60000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || '2000', 10);

if (!CRM_SYNC_URL || !CRM_SYNC_TOKEN) {
  console.error('❌ Falta configurar CRM_SYNC_URL o CRM_SYNC_TOKEN en el archivo .env del microservicio.');
  process.exit(1);
}

// ============================================================================
// WPPCONNECT LOGGER CONFIGURATION
// ============================================================================
// https://wppconnect.io/docs/tutorial/basics/configuring-logger
try {
  wppconnect.defaultLogger.level = 'info';
} catch (e) {
  console.warn('⚠️ No se pudo configurar el logger de WPPConnect:', e.message);
}

// ============================================================================
// ALMACENAMIENTO DE ESTADO
// ============================================================================

const activeClients = new Map();
const BROWSER_DATA_DIR = path.resolve(process.cwd(), '.wpp_browser_data');
const TOKENS_DIR = path.resolve(process.cwd(), 'tokens');

// Ensure directories exist
if (!fs.existsSync(BROWSER_DATA_DIR)) fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });

// ============================================================================
// UTILIDADES
// ============================================================================

function extractPhoneFromId(id) {
  if (!id) return '';
  const colonIndex = id.indexOf(':');
  if (colonIndex !== -1) {
    const beforeColon = id.substring(0, colonIndex);
    if (/^\d+$/.test(beforeColon) && beforeColon.length >= 10 && beforeColon.length <= 15) {
      return beforeColon;
    }
    return '';
  }
  const atIndex = id.indexOf('@');
  return atIndex === -1 ? id : id.substring(0, atIndex);
}

function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return '';
  let normalized = phoneNumber.replace(/\D/g, '');
  if (normalized.includes('@')) {
    normalized = extractPhoneFromId(normalized);
  }
  return normalized;
}

function isValidPhoneNumber(phoneNumber) {
  if (!phoneNumber) return false;
  if (phoneNumber.includes(':')) return false;
  const normalized = normalizePhoneNumber(phoneNumber);
  if (normalized.length < 10 || normalized.length > 20) return false;
  if (!/^\d+$/.test(normalized)) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, maxRetries = MAX_RETRIES, delay = RETRY_DELAY) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        console.warn(`⚠️ Intento ${i + 1}/${maxRetries} falló, reintentando en ${delay}ms...`);
        await sleep(delay);
        delay *= 2;
      }
    }
  }
  throw lastError;
}

async function fetchWithTimeout(url, options = {}, timeout = HTTP_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout después de ${timeout}ms`);
    }
    throw error;
  }
}

// ============================================================================
// COMUNICACIÓN CON EL CRM
// ============================================================================

async function sendToCrm(payload) {
  return retry(async () => {
    try {
      const res = await fetchWithTimeout(CRM_SYNC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CRM_SYNC_TOKEN}`,
        },
        body: JSON.stringify(payload),
      }, HTTP_TIMEOUT);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Error ${res.status} ${res.statusText}: ${text.substring(0, 200)}`);
      }

      const data = await res.json().catch(() => ({}));
      return data;
    } catch (err) {
      console.error(`❌ [${payload.sessionId || 'default'}] Error sincronizando con CRM:`, err.message);
      return null;
    }
  });
}

async function sendQrToCrm(sessionId, base64Qr, status) {
  return sendQrToCrmWithExpiration(sessionId, base64Qr, status, null, null, null);
}

async function sendQrToCrmWithExpiration(sessionId, base64Qr, status, qrTimeoutSeconds, qrExpiresAt, timeRemaining) {
  if (!CRM_QR_URL) return;

  const maxRetries = status === 'connected' ? 3 : 1;

  return retry(async () => {
    try {
      const sessionData = activeClients.get(sessionId);
      const accountPhone = sessionData?.accountPhone || null;

      const payload = {
        sessionId,
        qrBase64: base64Qr,
        status,
        timestamp: Date.now(),
      };

      if (accountPhone) payload.accountPhone = accountPhone;
      if (qrTimeoutSeconds) payload.qrTimeoutSeconds = qrTimeoutSeconds;
      if (qrExpiresAt) payload.qrExpiresAt = qrExpiresAt;
      if (timeRemaining !== undefined && timeRemaining !== null) payload.timeRemaining = timeRemaining;

      const res = await fetchWithTimeout(CRM_QR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CRM_SYNC_TOKEN}`,
        },
        body: JSON.stringify(payload),
      }, HTTP_TIMEOUT);

      if (!res.ok) {
        const text = await res.text();
        console.warn(`⚠️ [${sessionId}] CRM rechazó QR/Status (${status}): ${res.status} - ${text.substring(0, 100)}`);
        return;
      }

      return await res.json().catch(() => ({}));
    } catch (err) {
      console.error(`❌ [${sessionId}] Error enviando señal QR al CRM (status: ${status}):`, err.message);
      throw err;
    }
  }, maxRetries);
}

async function loadSessionsFromCrm() {
  if (!CRM_SESSIONS_URL) return null;

  try {
    const res = await fetchWithTimeout(CRM_SESSIONS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${CRM_SYNC_TOKEN}` },
    }, HTTP_TIMEOUT);

    if (!res.ok) return null;

    const data = await res.json();
    const sessions = (data.sessions || [])
      .filter((s) => s.enabled !== false && s.status === 'connected')
      .map((s) => s.id)
      .filter(Boolean);

    return sessions.length > 0 ? sessions : null;
  } catch (err) {
    console.error('❌ Error de red al obtener sesiones desde CRM:', err.message);
    return null;
  }
}

// ============================================================================
// GESTIÓN DE SESIONES WPPCONNECT
// ============================================================================

function setupQrUpdateInterval(sessionName, qrInfo) {
  const sessionData = activeClients.get(sessionName);
  if (!sessionData) return;

  if (sessionData.qrUpdateInterval) clearInterval(sessionData.qrUpdateInterval);
  sessionData.qrExpiresAt = qrInfo.expiresAt;

  sessionData.qrUpdateInterval = setInterval(() => {
    const currentSessionData = activeClients.get(sessionName);
    if (!currentSessionData) {
      if (sessionData.qrUpdateInterval) clearInterval(sessionData.qrUpdateInterval);
      return;
    }

    if (currentSessionData.isConnected) {
      if (currentSessionData.qrUpdateInterval) {
        clearInterval(currentSessionData.qrUpdateInterval);
        currentSessionData.qrUpdateInterval = null;
      }
      return;
    }

    // Check connection state
    if (currentSessionData.client) {
      isClientConnected(currentSessionData.client).then((connected) => {
        if (connected) {
          if (currentSessionData.qrUpdateInterval) {
            clearInterval(currentSessionData.qrUpdateInterval);
            currentSessionData.qrUpdateInterval = null;
          }
          currentSessionData.isConnected = true;
          sendQrToCrm(sessionName, null, 'connected').catch(console.error);
        }
      });
    }

    const now = Date.now();
    const timeRemaining = Math.max(0, Math.floor((qrInfo.expiresAt - now) / 1000));

    if (timeRemaining <= 0) {
      console.log(`⏱️ [${sessionName}] QR expiró, limpiando...`);
      if (currentSessionData.qrUpdateInterval) {
        clearInterval(currentSessionData.qrUpdateInterval);
        currentSessionData.qrUpdateInterval = null;
      }
      cleanupSessionCompletely(sessionName, 'QR expired').catch(console.error);
      return;
    }

    sendQrToCrmWithExpiration(sessionName, null, 'waiting_qr', qrInfo.timeoutSeconds, qrInfo.expiresAt, timeRemaining).catch(console.error);
  }, 5000);
}

function cleanupSessionTokens(sessionName) {
  try {
    const tokensPath = path.resolve(TOKENS_DIR, sessionName);

    // Clean everything related to session in tokens dir
    const files = fs.readdirSync(TOKENS_DIR);
    for (const file of files) {
      if (file.includes(sessionName)) {
        const fullPath = path.join(TOKENS_DIR, file);
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    }
    return true;
  } catch (err) {
    console.error(`❌ [${sessionName}] Error eliminando tokens:`, err.message);
    return false;
  }
}

async function cleanupSessionTokensWithRetry(sessionName, maxRetries = 3, retryDelay = 2000) {
  try {
    for (let i = 0; i < maxRetries; i++) {
      if (cleanupSessionTokens(sessionName)) return true;
      await sleep(retryDelay);
    }
  } catch (e) { }
  return false;
}

function cleanupSession(sessionName) {
  const sessionData = activeClients.get(sessionName);
  if (sessionData) {
    if (sessionData.qrUpdateInterval) clearInterval(sessionData.qrUpdateInterval);
    activeClients.delete(sessionName);
  }
}

async function killBrowserProcesses(sessionName) {
  try {
    console.log(`🔪 [${sessionName}] Matando procesos del navegador...`);
    if (process.platform === 'win32') {
      // Matar procesos especificos de esta sesión
      await execAsync(`wmic process where "CommandLine like '%${sessionName}%' and Name like 'chrome.exe'" call terminate`).catch(() => { });
    } else {
      await execAsync(`pkill -f "chrome.*${sessionName}" || true`);
    }
    await sleep(1000);
  } catch (err) { }
}

async function cleanupSessionCompletely(sessionName, reason = 'Cleanup') {
  console.log(`🧹 [${sessionName}] Limpieza completa: ${reason}`);
  const sessionData = activeClients.get(sessionName);

  if (sessionData) {
    activeClients.delete(sessionName);
    if (sessionData.client) {
      try {
        await sessionData.client.close();
      } catch (e) {
        console.error(`Error cerrando cliente ${sessionName}:`, e.message);
      }
    }
    if (sessionData.qrUpdateInterval) clearInterval(sessionData.qrUpdateInterval);
  }

  await killBrowserProcesses(sessionName);

  // Wait for file locks to release
  await sleep(1500);
  cleanupSessionTokensWithRetry(sessionName, 3, 1000);

  // Remove browser data directory
  try {
    const sessionBrowserDir = path.resolve(BROWSER_DATA_DIR, sessionName);
    if (fs.existsSync(sessionBrowserDir)) {
      fs.rmSync(sessionBrowserDir, { recursive: true, force: true });
    }
  } catch (e) { }

  try {
    let status = 'qr_expired';
    if (reason.includes('Manual')) status = 'cleaned';
    if (reason.includes('Limit')) status = 'qr_limit_reached';
    await sendQrToCrm(sessionName, null, status);
  } catch (e) { }
}

async function isClientConnected(client) {
  try {
    if (!client) return false;
    const state = await client.getConnectionState();
    return state === 'CONNECTED' || state === 'OPENING';
  } catch (error) {
    return false;
  }
}

async function startSession(sessionName) {
  if (activeClients.has(sessionName)) {
    const existing = activeClients.get(sessionName);
    if (existing.state === 'INITIALIZING') {
      console.log(`⚠️ [${sessionName}] Ya se está inicializando.`);
      return;
    }
    if (existing.client && await isClientConnected(existing.client)) {
      console.log(`✅ [${sessionName}] Ya conectado.`);
      return;
    }
    await cleanupSessionCompletely(sessionName, 'Restarting session');
  }

  console.log(`🚀 [${sessionName}] Iniciando sesión con WPPConnect...`);

  const sessionData = {
    client: null,
    accountPhone: null,
    connectedAt: null,
    state: 'INITIALIZING',
    qrExpiresAt: null,
    qrUpdateInterval: null,
    isConnected: false,
    qrAttempts: 0,
  };

  activeClients.set(sessionName, sessionData);

  try {
    // Separate paths logic
    const sessionUserDataDir = path.resolve(BROWSER_DATA_DIR, sessionName);

    // https://wppconnect.io/docs/tutorial/basics/creating-client
    const client = await wppconnect.create({
      session: sessionName,
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        const current = activeClients.get(sessionName);
        if (!current) {
          console.log(`[${sessionName}] Abortado.`);
          killBrowserProcesses(sessionName);
          return;
        }

        if (current.isConnected) return;

        if (attempts >= 3) {
          console.log(`[${sessionName}] QR (3) alcanzado. Deteniendo.`);
          cleanupSessionCompletely(sessionName, 'QR Limit Reached').catch(console.error);
          return;
        }

        current.qrAttempts = attempts;
        console.log(`📱 [${sessionName}] QR Generado (${attempts}/3)`);

        const QR_TIMEOUT = 60;
        const expiresAt = Date.now() + (QR_TIMEOUT * 1000);

        sendQrToCrmWithExpiration(sessionName, base64Qr, 'waiting_qr', QR_TIMEOUT, expiresAt, QR_TIMEOUT).catch(console.error);

        setupQrUpdateInterval(sessionName, { expiresAt, timeoutSeconds: QR_TIMEOUT });
      },
      statusFind: (statusSession, session) => {
        console.log(`ℹ️ [${sessionName}] Status: ${statusSession}`);
        const current = activeClients.get(sessionName);
        if (current) current.state = statusSession;

        if (['isLogged', 'qrReadSuccess', 'inChat'].includes(statusSession)) {
          console.log(`✅ [${sessionName}] Conectado! (Status: ${statusSession})`);
          if (current) {
            current.isConnected = true;
            if (current.qrUpdateInterval) clearInterval(current.qrUpdateInterval);
            sendQrToCrm(sessionName, null, 'connected').catch(console.error);
          }
        }

        if (['browserClose', 'desconnectedMobile', 'serverClose'].includes(statusSession)) {
          if (current && current.isConnected) {
            console.warn(`⚠️ [${sessionName}] Desconectado: ${statusSession}`);
            sendQrToCrm(sessionName, null, 'disconnected').catch(console.error);
            cleanupSession(sessionName);
          }
        }
      },
      // Configuración de navegador para servidor / Docker
      headless: true, // Use false if you need to debug visually
      devtools: false,
      useChrome: true, // Requires Chrome installed. If false, uses bundled Chromium.
      debug: false,
      logQR: false, // We handle QR manually
      updatesLog: false,
      disableWelcome: true,
      autoClose: 0, // Keep session alive
      tokenStore: 'file',
      folderNameToken: TOKENS_DIR,
      puppeteerOptions: {
        userDataDir: sessionUserDataDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
          '--disable-extensions'
        ]
      }
    });

    if (!activeClients.has(sessionName)) {
      client.close().catch(() => { });
      killBrowserProcesses(sessionName);
      return;
    }

    const current = activeClients.get(sessionName);
    current.client = client;
    current.state = 'CONNECTED';
    current.isConnected = true;

    // Start phone watchdog to keep connection alive
    if (client.startPhoneWatchdog) {
      client.startPhoneWatchdog(30000);
    }

    // Attempt to fetch account phone with retries
    let retryCount = 0;
    while (retryCount < 5 && !current.accountPhone) {
      try {
        const hostDevice = await client.getHostDevice();
        const phone = hostDevice?.wid?.user;
        if (phone) {
          current.accountPhone = phone;
          console.log(`📱 [${sessionName}] Teléfono de cuenta detectado: ${current.accountPhone}`);
        } else {
          await sleep(2000);
        }
      } catch (e) {
        await sleep(2000);
      }
      retryCount++;
    }

    if (!current.accountPhone) {
      console.warn(`⚠️ [${sessionName}] No se pudo detectar el teléfono de la cuenta tras varios intentos.`);
    }

    // Using onAnyMessage to capture all incoming messages including media
    // https://wppconnect.io/docs/tutorial/basics/receiving-messages
    client.onAnyMessage(async (message) => {
      // 1. Filtrado de mensajes de sistema y tipos no deseados
      if (['e2e_notification', 'call_log', 'protocol', 'ciphertext', 'revoked', 'gp2', 'notification_template'].includes(message.type)) {
        return;
      }

      if (message.isGroupMsg) return;

      // 2. Verificación de accountPhone
      if (!current.accountPhone) {
        // Último intento de obtenerlo si llegó un mensaje
        try {
          const hostDevice = await client.getHostDevice();
          if (hostDevice?.wid?.user) current.accountPhone = hostDevice.wid.user;
        } catch (e) { }

        if (!current.accountPhone) {
          console.warn(`[${sessionName}] Ignorando mensaje (sin accountPhone): ${message.id}`);
          return;
        }
      }

      try {
        const fromMe = message.fromMe === true;
        const direction = fromMe ? 'outbound' : 'inbound';
        const contactId = fromMe ? message.to : (message.from || message.to);
        const contactPhone = extractPhoneFromId(contactId);
        let messageText = message.body || '';

        // Better media/type handling
        if (['chat', 'text'].includes(message.type)) {
          // Already handled
        } else if (message.type === 'location') {
          messageText = `Ubicación: ${message.lat}, ${message.lng}`;
        } else if (message.type === 'vcard' || message.type === 'multi_vcard') {
          messageText = `Contacto: ${message.body || 'Tarjeta de contacto'}`;
        } else if (!messageText) {
          messageText = message.caption || message.content || `[Multimedia: ${message.type}]`;
        }

        if (!messageText) messageText = `[${message.type}]`;

        const payload = {
          sessionId: sessionName,
          accountPhone: current.accountPhone,
          contactPhone,
          contactName: message.sender?.pushname || contactPhone,
          messageText: messageText,
          messageId: message.id,
          messageType: message.type,
          direction,
          timestamp: typeof message.timestamp === 'number'
            ? (message.timestamp < 10000000000 ? message.timestamp * 1000 : message.timestamp)
            : Date.now()
        };
        sendToCrm(payload).catch(() => { });
      } catch (e) { console.error('Error procesando mensaje', e); }
    });

    client.onStateChange((state) => {
      if (state === 'CONNECTED') {
        current.isConnected = true;
        sendQrToCrm(sessionName, null, 'connected').catch(console.error);
      }
      if (state === 'DISCONNECTED' || state === 'CONFLICT') {
        sendQrToCrm(sessionName, null, 'disconnected').catch(console.error);
        activeClients.delete(sessionName);
      }
    });

  } catch (err) {
    if (err.message && err.message.includes('already running')) {
      await killBrowserProcesses(sessionName);
    }
    console.error(`❌ [${sessionName}] Init failed:`, err.message);
    activeClients.delete(sessionName);
    sendQrToCrm(sessionName, null, 'error').catch(console.error);
  }
}

// ============================================================================
// SERVIDOR HTTP
// ============================================================================
const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.json({
  ok: true,
  active: activeClients.size,
  sessions: Array.from(activeClients.keys())
}));

app.post('/sessions/:sessionId/request-qr', async (req, res) => {
  const { sessionId } = req.params;
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token !== CRM_SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  let id = sessionId.trim().replace(/[^a-zA-Z0-9_\-]/g, '');
  if (!id) return res.status(400).json({ error: 'Invalid ID' });

  if (activeClients.has(id)) {
    await cleanupSessionCompletely(id, 'Reload Request');
  } else {
    await cleanupSessionTokensWithRetry(id);
    await killBrowserProcesses(id);
  }

  startSession(id);
  res.json({ ok: true });
});

app.post('/sessions/:sessionId/send', async (req, res) => {
  const { sessionId } = req.params;
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token !== CRM_SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const id = sessionId.trim();
  const session = activeClients.get(id);

  if (!session || !session.client) {
    return res.status(404).json({ error: 'Session not connected' });
  }

  try {
    const { phoneNumber, message } = req.body;
    let phone = normalizePhoneNumber(phoneNumber);
    if (!phone.includes('@')) phone += '@c.us';
    const result = await session.client.sendText(phone, message);
    res.json({ success: true, parsedId: result?.id?._serialized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/sessions/:sessionId/cleanup', async (req, res) => {
  const { sessionId } = req.params;
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token !== CRM_SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  await cleanupSessionCompletely(sessionId.trim(), 'Manual Request');
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

process.on('uncaughtException', (err) => console.error('🔥 Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('🔥 Unhandled:', err));

async function bootstrap() {
  const sessions = await loadSessionsFromCrm();
  if (sessions) {
    for (const id of sessions) {
      await startSession(id);
      await sleep(5000);
    }
  }
}
bootstrap();
