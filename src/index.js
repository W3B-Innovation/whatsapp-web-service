require('dotenv').config();

const fetch = require('node-fetch');
const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');

const CRM_SYNC_URL = process.env.CRM_SYNC_URL;
const CRM_SYNC_TOKEN = process.env.CRM_SYNC_TOKEN;
const ACCOUNT_LABEL = process.env.ACCOUNT_LABEL || 'colaborador-1';
// URL opcional para obtener sesiones desde el CRM
// Ej: http://localhost:3000/api/whatsapp/web-sync/sessions
const CRM_SESSIONS_URL = process.env.CRM_SESSIONS_URL;
// URL para enviar el QR al CRM
// Ej: http://localhost:3000/api/whatsapp/web-sync/qr
const CRM_QR_URL = process.env.CRM_QR_URL || (CRM_SYNC_URL ? CRM_SYNC_URL.replace('/web-sync', '/web-sync/qr') : null);
const PORT = process.env.PORT || 4000;

if (!CRM_SYNC_URL || !CRM_SYNC_TOKEN) {
  console.error(
    '❌ Falta configurar CRM_SYNC_URL o CRM_SYNC_TOKEN en el archivo .env del microservicio.'
  );
  process.exit(1);
}

// --- Servidor HTTP para comunicación con el CRM ---
const app = express();
app.use(express.json());

// Healthcheck simple
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'whatsapp-web-sync-service running' });
});

// Endpoint para que el CRM pueda pedir que se inicie una sesión (y se genere el QR)
// NOTA: El QR sigue mostrándose en los logs del microservicio.
app.post('/sessions/:sessionId/request-qr', async (req, res) => {
  const { sessionId } = req.params;

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.substring('Bearer '.length)
    : authHeader;

  if (token !== CRM_SYNC_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!sessionId || !sessionId.trim()) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  console.log(
    `📥 Petición del CRM para iniciar sesión "${sessionId}" y generar QR de vinculación`
  );

  // Iniciar la sesión (esto disparará catchQR y mostrará el QR en los logs)
  startSession(sessionId.trim());

  return res.json({
    ok: true,
    message:
      'Sesión iniciada. El QR se generará en el microservicio y debe mostrarse en los logs de consola.',
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP escuchando en el puerto ${PORT}`);
});

function extractPhoneFromId(id) {
  if (!id) return '';
  const atIndex = id.indexOf('@');
  return atIndex === -1 ? id : id.substring(0, atIndex);
}

async function sendToCrm(payload) {
  try {
    const res = await fetch(CRM_SYNC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CRM_SYNC_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        '❌ Error al sincronizar con el CRM:',
        res.status,
        res.statusText,
        text
      );
    } else {
      const data = await res.json().catch(() => ({}));
      console.log(
        `✅ [${payload.sessionId || 'default'}] Mensaje sincronizado con CRM (guardados: ${data.saved || 1})`
      );
    }
  } catch (err) {
    console.error('❌ Error de red al llamar al CRM:', err);
  }
}

async function sendQrToCrm(sessionId, base64Qr, status) {
  if (!CRM_QR_URL) {
    console.warn(`⚠️ [${sessionId}] CRM_QR_URL no configurado, no se puede enviar QR al CRM`);
    return;
  }

  try {
    const res = await fetch(CRM_QR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CRM_SYNC_TOKEN}`,
      },
      body: JSON.stringify({
        sessionId,
        qrBase64: base64Qr,
        status,
        timestamp: Date.now(),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `❌ [${sessionId}] Error enviando QR al CRM:`,
        res.status,
        res.statusText,
        text
      );
    } else {
      console.log(`✅ [${sessionId}] QR enviado al CRM exitosamente`);
    }
  } catch (err) {
    console.error(`❌ [${sessionId}] Error de red al enviar QR al CRM:`, err);
  }
}

async function loadSessionsFromCrm() {
  if (!CRM_SESSIONS_URL) return null;

  try {
    const res = await fetch(CRM_SESSIONS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${CRM_SYNC_TOKEN}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        '❌ Error obteniendo sesiones desde CRM:',
        res.status,
        res.statusText,
        text
      );
      return null;
    }

    const data = await res.json();
    const sessions = (data.sessions || [])
      // Considerar habilitadas si enabled es true o no está definido
      .filter((s) => s.enabled !== false)
      .map((s) => s.id)
      .filter(Boolean);

    return sessions.length > 0 ? sessions : null;
  } catch (err) {
    console.error('❌ Error de red al obtener sesiones desde CRM:', err);
    return null;
  }
}

console.log('🚀 Preparando cliente(s) de WhatsApp (WPPConnect)...');

function startSession(sessionName) {
  wppconnect
    .create({
      session: sessionName,
      headless: true,
      puppeteerOptions: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      catchQR: (base64Qr, asciiQR, attempts) => {
        console.log(
          `📱 [${sessionName}] Escanea este QR con la app de WhatsApp Business del colaborador (intento ${attempts}):`
        );
        console.log(asciiQR);
        // Enviar QR al CRM para que se muestre en la UI
        sendQrToCrm(sessionName, base64Qr, 'waiting_qr');
      },
      statusFind: (statusSession) => {
        console.log(`ℹ️ [${sessionName}] Estado de sesión WPPConnect:`, statusSession);
        // Enviar actualización de estado al CRM
        if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess') {
          sendQrToCrm(sessionName, null, 'connected');
        } else if (statusSession === 'notLogged' || statusSession === 'disconnectedMobile') {
          sendQrToCrm(sessionName, null, 'disconnected');
        }
      },
      logQR: false,
    })
    .then((client) => {
      console.log('✅ Sesión WPPConnect inicializada para', sessionName);

      client.onStateChange((state) => {
        console.log(`🔁 [${sessionName}] Estado de WhatsApp:`, state);
        if (state === 'DISCONNECTED' || state === 'CONFLICT') {
          console.warn(`⚠️ [${sessionName}] Sesión desconectada/CONFLICT, cerrando cliente`);
          client.close();
        }
      });

      // onAnyMessage captura tanto entrantes como salientes
      client.onAnyMessage(async (message) => {
        try {
          // Ignorar grupos y mensajes sin texto
          if (message.isGroupMsg) return;

          const messageText = message.body || '';
          if (!messageText.trim()) return;

          const fromMe = message.fromMe === true;
          const direction = fromMe ? 'outbound' : 'inbound';

          // En WPPConnect, para mensajes normales:
          // - message.from = jid del remitente
          // - message.to   = jid del destinatario
          const accountId = fromMe ? message.from : message.to;
          const contactId = fromMe ? message.to : message.from;

          const accountPhone = extractPhoneFromId(accountId);
          const contactPhone = extractPhoneFromId(contactId);

          const contactName =
            message.sender?.pushname ||
            message.sender?.name ||
            message.chat?.name ||
            contactPhone;

          const timestampMs =
            (typeof message.timestamp === 'number'
              ? message.timestamp
              : Number(message.timestamp || 0)) * 1000 || Date.now();

          const payload = {
            sessionId: sessionName,
            accountPhone,
            contactPhone,
            contactName,
            messageText,
            direction,
            messageId: message.id || message.id?._serialized,
            timestamp: timestampMs,
          };

          console.log(
            `📨 [${sessionName}] Mensaje ${direction} ${contactPhone} <-[${accountPhone}]: "${messageText}"`
          );

          await sendToCrm(payload);
        } catch (err) {
          console.error(`❌ [${sessionName}] Error procesando mensaje de WPPConnect:`, err);
        }
      });
    })
    .catch((error) => {
      console.error(`❌ [${sessionName}] Error iniciando WPPConnect:`, error);
    });
}

async function bootstrap() {
  // 1) Intentar cargar sesiones desde el CRM
  let sessions = await loadSessionsFromCrm();

  // 2) Si no hay sesiones en CRM, no usar fallback de .env: esperar a que el CRM cree sesiones
  if (!sessions || sessions.length === 0) {
    console.log(
      'ℹ️ No se encontraron sesiones habilitadas en CRM. ' +
        'Crea sesiones en la colección "whatsapp_web_sessions" desde el panel de administración del CRM ' +
        'y reinicia este microservicio para iniciar el proceso de vinculación (QR).'
    );
    return;
  }

  console.log('✅ Sesiones cargadas desde CRM:', sessions);

  sessions.forEach((s) => startSession(s));
}

bootstrap().catch((err) => {
  console.error('❌ Error al iniciar las sesiones de WPPConnect:', err);
});
