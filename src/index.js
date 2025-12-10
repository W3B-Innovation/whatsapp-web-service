require('dotenv').config();

const fetch = require('node-fetch');
const wppconnect = require('@wppconnect-team/wppconnect');

const CRM_SYNC_URL = process.env.CRM_SYNC_URL;
const CRM_SYNC_TOKEN = process.env.CRM_SYNC_TOKEN;
const ACCOUNT_LABEL = process.env.ACCOUNT_LABEL || 'colaborador-1';
// URL opcional para obtener sesiones desde el CRM
// Ej: https://tu-crm.com/api/whatsapp/web-sync/sessions
const CRM_SESSIONS_URL = process.env.CRM_SESSIONS_URL;
// Lista de sesiones por defecto desde .env, separadas por coma. Ej: "colab-1,colab-2,colab-3"
const SESSIONS_ENV = (process.env.SESSIONS || ACCOUNT_LABEL)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!CRM_SYNC_URL || !CRM_SYNC_TOKEN) {
  console.error(
    '❌ Falta configurar CRM_SYNC_URL o CRM_SYNC_TOKEN en el archivo .env del microservicio.'
  );
  process.exit(1);
}

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
      },
      statusFind: (statusSession) => {
        console.log(`ℹ️ [${sessionName}] Estado de sesión WPPConnect:`, statusSession);
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

  // 2) Si no hay, usar las definidas en .env
  if (!sessions || sessions.length === 0) {
    sessions = SESSIONS_ENV;
    console.log(
      'ℹ️ No se encontraron sesiones desde CRM, usando sesiones de entorno (.env):',
      sessions
    );
  } else {
    console.log('✅ Sesiones cargadas desde CRM:', sessions);
  }

  sessions.forEach((s) => startSession(s));
}

bootstrap().catch((err) => {
  console.error('❌ Error al iniciar las sesiones de WPPConnect:', err);
});
