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

// Log de configuración al inicio
console.log('🔧 [CONFIG] CRM_SYNC_URL:', CRM_SYNC_URL);
console.log('🔧 [CONFIG] CRM_QR_URL:', CRM_QR_URL);
console.log('🔧 [CONFIG] CRM_QR_URL calculado:', CRM_SYNC_URL ? CRM_SYNC_URL.replace('/web-sync', '/web-sync/qr') : 'null');

const PORT = process.env.PORT || 4000;
const HTTP_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT || '30000', 10); // 30 segundos por defecto
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || '1000', 10); // 1 segundo

if (!CRM_SYNC_URL || !CRM_SYNC_TOKEN) {
  console.error(
    '❌ Falta configurar CRM_SYNC_URL o CRM_SYNC_TOKEN en el archivo .env del microservicio.'
  );
  process.exit(1);
}

// ============================================================================
// ALMACENAMIENTO DE ESTADO
// ============================================================================

// Almacenar clientes activos con información adicional
const activeClients = new Map(); // sessionId -> { client, accountPhone, connectedAt, state, qrExpiresAt, qrUpdateInterval, qrAttempts }

// ============================================================================
// UTILIDADES
// ============================================================================

/**
 * Extrae el número de teléfono de un ID de WhatsApp
 * IMPORTANTE: Si el ID tiene formato especial (ej: "158386180104220:2"), 
 * extrae solo la parte numérica antes de ":" o "@"
 */
function extractPhoneFromId(id) {
  if (!id) return '';
  
  // Si tiene formato especial con ":" (ej: "158386180104220:2@c.us" o "158386180104220:2")
  // extraer solo la parte antes de ":"
  const colonIndex = id.indexOf(':');
  if (colonIndex !== -1) {
    // Si tiene ":", es probablemente un ID de grupo o formato especial, no un número real
    // Extraer la parte antes de ":" para intentar obtener el número
    const beforeColon = id.substring(0, colonIndex);
    // Si la parte antes de ":" es solo números y tiene longitud razonable, usarla
    if (/^\d+$/.test(beforeColon) && beforeColon.length >= 10 && beforeColon.length <= 12) {
      return beforeColon;
    }
    // Si no, retornar vacío porque no es un número válido
    return '';
  }
  
  // Si no tiene ":", extraer antes de "@" como antes
  const atIndex = id.indexOf('@');
  return atIndex === -1 ? id : id.substring(0, atIndex);
}

/**
 * Normaliza un número de teléfono para WhatsApp
 */
function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return '';
  // Remover caracteres no numéricos
  let normalized = phoneNumber.replace(/\D/g, '');
  // Si ya tiene @, extraer solo el número
  if (normalized.includes('@')) {
    normalized = extractPhoneFromId(normalized);
  }
  return normalized;
}

/**
 * Valida que un número de teléfono tenga formato válido
 * Los números de teléfono reales normalmente tienen 10-12 dígitos (con código de país)
 * Números con más de 12 dígitos o con formato especial (":2") no son números válidos
 */
function isValidPhoneNumber(phoneNumber) {
  if (!phoneNumber) return false;
  
  // Si tiene formato especial con ":", no es un número válido
  if (phoneNumber.includes(':')) {
    return false;
  }
  
  const normalized = normalizePhoneNumber(phoneNumber);
  
  // Validar longitud: números de teléfono reales tienen 10-12 dígitos
  // (10 dígitos locales + 1-2 dígitos de código de país)
  // Números con más de 12 dígitos probablemente son IDs, no números reales
  if (normalized.length < 10 || normalized.length > 12) {
    return false;
  }
  
  // Validar que sea solo números
  if (!/^\d+$/.test(normalized)) {
    return false;
  }
  
  return true;
}

/**
 * Espera un tiempo determinado
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper para funciones async
 */
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
        delay *= 2; // Exponential backoff
      }
    }
  }
  throw lastError;
}

/**
 * Fetch con timeout
 */
async function fetchWithTimeout(url, options = {}, timeout = HTTP_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
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

/**
 * Envía mensajes al CRM con retry y timeout
 */
async function sendToCrm(payload) {
  return retry(async () => {
  try {
      const res = await fetchWithTimeout(
        CRM_SYNC_URL,
        {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CRM_SYNC_TOKEN}`,
      },
      body: JSON.stringify(payload),
        },
        HTTP_TIMEOUT
      );

    if (!res.ok) {
      const text = await res.text();
        throw new Error(
          `Error ${res.status} ${res.statusText}: ${text.substring(0, 200)}`
        );
      }

      const data = await res.json().catch(() => ({}));
      console.log(
        `✅ [${payload.sessionId || 'default'}] Mensaje sincronizado con CRM (guardados: ${data.saved || 1})`
      );
      return data;
    } catch (err) {
      console.error(
        `❌ [${payload.sessionId || 'default'}] Error sincronizando con CRM:`,
        err.message
      );
      throw err;
    }
  });
}

/**
 * Envía QR al CRM con retry y timeout
 */
async function sendQrToCrm(sessionId, base64Qr, status) {
  return sendQrToCrmWithExpiration(sessionId, base64Qr, status, null, null, null);
}

/**
 * Envía QR al CRM con información de expiración
 */
async function sendQrToCrmWithExpiration(
  sessionId,
  base64Qr,
  status,
  qrTimeoutSeconds,
  qrExpiresAt,
  timeRemaining
) {
  if (!CRM_QR_URL) {
    console.warn(`⚠️ [${sessionId}] CRM_QR_URL no configurado, no se puede enviar QR al CRM`);
    console.warn(`⚠️ [${sessionId}] CRM_SYNC_URL: ${CRM_SYNC_URL}`);
    console.warn(`⚠️ [${sessionId}] CRM_QR_URL calculado: ${CRM_SYNC_URL ? CRM_SYNC_URL.replace('/web-sync', '/web-sync/qr') : 'null'}`);
    return;
  }

  return retry(async () => {
    try {
      // Log de la URL que se está usando
      console.log(`🔗 [${sessionId}] Enviando a URL: ${CRM_QR_URL}`);
      console.log(`🔗 [${sessionId}] Método: POST`);
      console.log(`🔗 [${sessionId}] Status: ${status}`);
      
      // Obtener información adicional de la sesión si está disponible
      const sessionData = activeClients.get(sessionId);
      const accountPhone = sessionData?.accountPhone || null;
      
      const payload = {
        sessionId,
        qrBase64: base64Qr,
        status,
        timestamp: Date.now(),
      };

      // Agregar accountPhone si está disponible (especialmente importante cuando status es 'connected')
      if (accountPhone) {
        payload.accountPhone = accountPhone;
      }

      // Agregar información de expiración si está disponible
      if (qrTimeoutSeconds !== null && qrTimeoutSeconds !== undefined) {
        payload.qrTimeoutSeconds = qrTimeoutSeconds;
      }
      if (qrExpiresAt !== null && qrExpiresAt !== undefined) {
        payload.qrExpiresAt = qrExpiresAt;
      }
      if (timeRemaining !== null && timeRemaining !== undefined) {
        payload.timeRemaining = timeRemaining;
      }
      
      // Log del payload que se está enviando (especialmente importante para status 'connected')
      if (status === 'connected') {
        console.log(
          `📤 [${sessionId}] Enviando señal 'connected' al CRM con payload:`,
          JSON.stringify({ sessionId, status, accountPhone, hasQr: !!base64Qr }, null, 2)
        );
      }

      console.log(`📤 [${sessionId}] Enviando petición POST a ${CRM_QR_URL} con payload:`, JSON.stringify(payload, null, 2));
      console.log(`📤 [${sessionId}] Headers:`, JSON.stringify({ 'Content-Type': 'application/json', Authorization: `Bearer ${CRM_SYNC_TOKEN?.substring(0, 10)}...` }, null, 2));
      
      const res = await fetchWithTimeout(
        CRM_QR_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${CRM_SYNC_TOKEN}`,
          },
          body: JSON.stringify(payload),
        },
        HTTP_TIMEOUT
      );

      console.log(`📥 [${sessionId}] Respuesta recibida del CRM: status=${res.status}, ok=${res.ok}, statusText=${res.statusText}`);

    if (!res.ok) {
      const text = await res.text();
      const errorMsg = `Error ${res.status}: ${text.substring(0, 200)}`;
      console.error(`❌ [${sessionId}] Error del CRM al recibir señal (status: ${status}):`, errorMsg);
      console.error(`❌ [${sessionId}] URL usada: ${CRM_QR_URL}`);
      console.error(`❌ [${sessionId}] Body de respuesta completo: ${text}`);
      throw new Error(errorMsg);
    }

    // Leer respuesta del CRM
    const responseData = await res.json().catch(() => ({}));
    
    if (timeRemaining !== null && timeRemaining !== undefined) {
      console.log(`✅ [${sessionId}] Tiempo QR actualizado: ${timeRemaining}s restantes`);
    } else {
      if (status === 'connected') {
        console.log(`✅ [${sessionId}] Señal 'connected' enviada al CRM exitosamente. Respuesta del CRM:`, JSON.stringify(responseData, null, 2));
      } else {
        console.log(`✅ [${sessionId}] QR enviado al CRM exitosamente (status: ${status})`);
      }
    }
    
    return responseData;
  } catch (err) {
    console.error(`❌ [${sessionId}] Error enviando señal al CRM (status: ${status}):`, err.message);
    console.error(`❌ [${sessionId}] URL que falló: ${CRM_QR_URL}`);
    console.error(`❌ [${sessionId}] Tipo de error:`, err.name);
    if (err.code) {
      console.error(`❌ [${sessionId}] Código de error:`, err.code);
    }
    if (status === 'connected') {
      console.error(`❌ [${sessionId}] ERROR CRÍTICO: No se pudo enviar señal 'connected' al CRM. Esto impedirá que isPending se actualice a false.`);
      console.error(`❌ [${sessionId}] Stack trace:`, err.stack);
    }
    // Lanzar error para que retry funcione
    throw err;
  }
  }, status === 'connected' ? 5 : 2); // 5 reintentos para 'connected' (es crítico), 2 para otros estados
}

/**
 * Carga sesiones desde el CRM
 * Solo retorna sesiones que ya están conectadas (status: 'connected')
 */
async function loadSessionsFromCrm() {
  if (!CRM_SESSIONS_URL) return null;

  try {
    const res = await fetchWithTimeout(
      CRM_SESSIONS_URL,
      {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${CRM_SYNC_TOKEN}`,
      },
      },
      HTTP_TIMEOUT
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(
        '❌ Error obteniendo sesiones desde CRM:',
        res.status,
        res.statusText,
        text.substring(0, 200)
      );
      return null;
    }

    const data = await res.json();
    // Solo cargar sesiones que ya están conectadas (status: 'connected')
    // NO cargar sesiones pendientes o esperando QR
    const sessions = (data.sessions || [])
      .filter((s) => {
        // Solo sesiones conectadas y habilitadas
        return s.enabled !== false && s.status === 'connected';
      })
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

/**
 * Configura el intervalo de actualización del tiempo restante del QR
 */
function setupQrUpdateInterval(sessionName, qrInfo) {
  const sessionData = activeClients.get(sessionName);
  if (!sessionData) return;
  
  // Limpiar intervalo anterior si existe
  if (sessionData.qrUpdateInterval) {
    clearInterval(sessionData.qrUpdateInterval);
  }
  
  // Guardar información de expiración
  sessionData.qrExpiresAt = qrInfo.expiresAt;
  
  // Crear nuevo intervalo para actualizar el tiempo restante cada 5 segundos
  sessionData.qrUpdateInterval = setInterval(() => {
    // CRÍTICO: Verificar si la sesión se conectó antes de continuar
    const currentSessionData = activeClients.get(sessionName);
    if (!currentSessionData) {
      // Sesión eliminada, limpiar intervalo
      if (sessionData.qrUpdateInterval) {
        clearInterval(sessionData.qrUpdateInterval);
      }
      return;
    }
    
    if (currentSessionData.isConnected) {
      console.log(`ℹ️ [${sessionName}] Sesión conectada, deteniendo intervalo de QR`);
      if (currentSessionData.qrUpdateInterval) {
        clearInterval(currentSessionData.qrUpdateInterval);
        currentSessionData.qrUpdateInterval = null;
      }
      return;
    }
    
    // Verificar si el cliente está realmente conectado
    if (currentSessionData.client) {
      isClientConnected(currentSessionData.client).then((connected) => {
        if (connected) {
          console.log(`✅ [${sessionName}] Sesión conectada detectada, deteniendo intervalo de QR`);
          if (currentSessionData.qrUpdateInterval) {
            clearInterval(currentSessionData.qrUpdateInterval);
            currentSessionData.qrUpdateInterval = null;
          }
          currentSessionData.isConnected = true;
          // Enviar estado connected al CRM
          console.log(`📤 [${sessionName}] setupQrUpdateInterval detectó conexión: Enviando señal 'connected' al CRM`);
          sendQrToCrm(sessionName, null, 'connected')
            .then((response) => {
              console.log(`✅ [${sessionName}] Señal 'connected' enviada exitosamente desde setupQrUpdateInterval. Respuesta:`, JSON.stringify(response, null, 2));
            })
            .catch((err) => {
              console.error(`❌ [${sessionName}] ERROR CRÍTICO enviando 'connected' desde setupQrUpdateInterval:`, err.message);
            });
          return;
        }
      }).catch(() => {
        // Continuar con el flujo normal si hay error
      });
    }
    
    const now = Date.now();
    const timeRemaining = Math.max(0, Math.floor((qrInfo.expiresAt - now) / 1000));
    
    // Si el tiempo expiró, limpiar completamente la sesión
    if (timeRemaining <= 0) {
      console.log(`⏱️ [${sessionName}] QR expiró (no escaneado), limpiando sesión completamente...`);
      
      // Limpiar intervalo
      if (currentSessionData && currentSessionData.qrUpdateInterval) {
        clearInterval(currentSessionData.qrUpdateInterval);
        currentSessionData.qrUpdateInterval = null;
      }
      
      // Limpiar completamente: tokens, cliente, y notificar al CRM para eliminar registro
      cleanupSessionCompletely(sessionName, 'QR expired - not scanned').catch((err) => {
        console.error(`❌ [${sessionName}] Error en limpieza completa:`, err.message);
      });
      
      return;
    }
    
    // Enviar actualización de tiempo restante
    sendQrToCrmWithExpiration(
      sessionName,
      null,
      'waiting_qr',
      qrInfo.timeoutSeconds,
      qrInfo.expiresAt,
      timeRemaining
    ).catch((err) => {
      console.error(`❌ [${sessionName}] Error actualizando tiempo QR:`, err.message);
    });
  }, 5000); // Actualizar cada 5 segundos
}

/**
 * Limpia los tokens de una sesión (elimina la carpeta de tokens)
 */
function cleanupSessionTokens(sessionName) {
  try {
    const tokensPath = path.join(__dirname, '..', 'tokens', sessionName);
    if (fs.existsSync(tokensPath)) {
      console.log(`🗑️ [${sessionName}] Eliminando tokens de sesión...`);
      
      // Intentar eliminar todos los archivos y carpetas dentro de tokensPath
      try {
        // Primero intentar eliminar archivos individuales si es necesario
        const files = fs.readdirSync(tokensPath);
        for (const file of files) {
          const filePath = path.join(tokensPath, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
              fs.rmSync(filePath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(filePath);
            }
          } catch (fileErr) {
            console.warn(`⚠️ [${sessionName}] No se pudo eliminar ${file}:`, fileErr.message);
          }
        }
      } catch (readErr) {
        // Si no se puede leer, intentar eliminar directamente
      }
      
      // Eliminar la carpeta completa
      fs.rmSync(tokensPath, { recursive: true, force: true });
      console.log(`✅ [${sessionName}] Tokens eliminados exitosamente`);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`❌ [${sessionName}] Error eliminando tokens:`, err.message);
    return false;
  }
}

/**
 * Intenta eliminar tokens con reintentos en caso de que estén bloqueados
 * @param {string} sessionName - Nombre de la sesión
 * @param {number} maxRetries - Número máximo de reintentos (default: 3)
 * @param {number} retryDelay - Delay entre reintentos en ms (default: 2000)
 * @returns {Promise<boolean>} - true si se eliminaron exitosamente, false si falló
 */
async function cleanupSessionTokensWithRetry(sessionName, maxRetries = 3, retryDelay = 2000) {
  const tokensPath = path.join(__dirname, '..', 'tokens', sessionName);
  
  if (!fs.existsSync(tokensPath)) {
    console.log(`ℹ️ [${sessionName}] No hay tokens para eliminar`);
    return true;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🗑️ [${sessionName}] Eliminando tokens (intento ${attempt}/${maxRetries})...`);
      fs.rmSync(tokensPath, { recursive: true, force: true });
      console.log(`✅ [${sessionName}] Tokens eliminados exitosamente`);
      return true;
    } catch (err) {
      if (err.code === 'EBUSY' || err.message?.includes('busy') || err.message?.includes('locked')) {
        if (attempt < maxRetries) {
          console.warn(`⚠️ [${sessionName}] Tokens bloqueados, reintentando en ${retryDelay}ms... (intento ${attempt}/${maxRetries})`);
          // Esperar antes de reintentar
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          // Continuar con el siguiente intento
          continue;
        } else {
          console.error(`❌ [${sessionName}] Error eliminando tokens después de ${maxRetries} intentos:`, err.message);
          console.warn(`⚠️ [${sessionName}] Los tokens pueden estar bloqueados por un proceso en ejecución. Intenta eliminar manualmente la carpeta: ${tokensPath}`);
          return false;
        }
      } else {
        console.error(`❌ [${sessionName}] Error eliminando tokens:`, err.message);
        return false;
      }
    }
  }
  
  return false;
}

/**
 * Verifica si los tokens tienen una cuenta vinculada
 * Si no tienen cuenta vinculada, los elimina
 * @param {string} sessionName - Nombre de la sesión
 * @returns {Promise<boolean>} - true si los tokens fueron eliminados, false si tienen cuenta vinculada o no existen
 */
async function verifyAndCleanupTokensIfUnlinked(sessionName) {
  try {
    const tokensPath = path.join(__dirname, '..', 'tokens', sessionName);
    
    // Si no existen tokens, no hay nada que verificar
    if (!fs.existsSync(tokensPath)) {
      console.log(`ℹ️ [${sessionName}] No hay tokens para verificar`);
      return false;
    }

    console.log(`🔍 [${sessionName}] Verificando si los tokens tienen cuenta vinculada...`);

    // Intentar crear un cliente temporal para verificar si tiene cuenta vinculada
    let tempClient = null;
    let hasLinkedAccount = false;
    let qrGenerated = false;

    try {
      // Crear cliente temporal con los tokens existentes
      // Usar un timeout total de 12 segundos para la verificación
      const verificationPromise = (async () => {
        tempClient = await wppconnect.create({
          session: sessionName,
          headless: true,
          devtools: false,
          useChrome: true,
          debug: false,
          logQR: false,
          browserWS: '',
          browserArgs: [],
          puppeteerOptions: {
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--no-zygote',
              '--disable-gpu',
              '--disable-web-security',
              '--disable-features=IsolateOrigins,site-per-process',
            ],
            headless: true,
            ignoreHTTPSErrors: true,
          },
          disableWelcome: true,
          updatesLog: false,
          autoClose: 0,
          tokenStore: 'file',
          folderNameToken: './tokens',
          catchQR: () => {
            // Si se genera un QR, significa que no hay cuenta vinculada
            qrGenerated = true;
            console.log(`⚠️ [${sessionName}] QR generado durante verificación - tokens no tienen cuenta vinculada`);
          },
        });

        // Esperar un momento para que el cliente se inicialice (tiempo reducido)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Si se generó un QR, no hay cuenta vinculada
        if (qrGenerated) {
          return false;
        }

        // Verificar si el cliente está conectado
        const isConnected = await isClientConnected(tempClient);
        
        if (isConnected) {
          // Intentar obtener información de la cuenta con timeout
          try {
            const hostDevicePromise = tempClient.getHostDevice();
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout obteniendo información de cuenta')), 5000)
            );
            
            const hostDevice = await Promise.race([hostDevicePromise, timeoutPromise]);
            const accountPhone = hostDevice?.wid?.user || hostDevice?.wid || null;
            
            if (accountPhone) {
              console.log(`✅ [${sessionName}] Tokens tienen cuenta vinculada: ${accountPhone}`);
              return true;
            } else {
              // Intentar otra forma de obtener el número
              try {
                const numberIdPromise = tempClient.getNumberId();
                const numberIdTimeout = new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Timeout')), 3000)
                );
                const numberId = await Promise.race([numberIdPromise, numberIdTimeout]);
                
                if (numberId) {
                  const phone = extractPhoneFromId(numberId);
                  console.log(`✅ [${sessionName}] Tokens tienen cuenta vinculada: ${phone}`);
                  return true;
                }
              } catch (err) {
                // Continuar sin número
              }
            }
            
            // Si llegamos aquí y no tenemos cuenta, pero está conectado, asumir que tiene cuenta
            // (puede ser que no se pudo obtener el número pero está conectado)
            console.log(`✅ [${sessionName}] Cliente conectado, tokens tienen cuenta vinculada`);
            return true;
          } catch (err) {
            console.log(`⚠️ [${sessionName}] Error obteniendo información de cuenta:`, err.message);
            // Si está conectado pero no se pudo obtener el número, asumir que tiene cuenta
            return true;
          }
        } else {
          console.log(`⚠️ [${sessionName}] Cliente no está conectado, tokens no tienen cuenta vinculada`);
          return false;
        }
      })();

      // Timeout total de 12 segundos para la verificación
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
          console.log(`⏱️ [${sessionName}] Timeout en verificación de tokens, asumiendo que no tienen cuenta vinculada`);
          resolve(false);
        }, 12000);
      });

      hasLinkedAccount = await Promise.race([verificationPromise, timeoutPromise]);

      // Cerrar el cliente temporal completamente
      if (tempClient) {
        try {
          console.log(`🔒 [${sessionName}] Cerrando cliente temporal...`);
          await Promise.race([
            tempClient.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout cerrando cliente')), 8000))
          ]);
          console.log(`✅ [${sessionName}] Cliente temporal cerrado`);
          
          // Esperar un momento adicional para asegurar que el navegador se haya cerrado completamente
          // Esto es importante porque Puppeteer puede mantener procesos en segundo plano
          await new Promise(resolve => setTimeout(resolve, 2000));
          console.log(`⏳ [${sessionName}] Esperando que el navegador se cierre completamente...`);
        } catch (closeErr) {
          console.warn(`⚠️ [${sessionName}] Error cerrando cliente temporal:`, closeErr.message);
          // Esperar de todas formas antes de continuar
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

    } catch (err) {
      console.log(`⚠️ [${sessionName}] Error verificando tokens (probablemente no tienen cuenta vinculada):`, err.message);
      // Si hay error al crear el cliente, probablemente los tokens no son válidos
      hasLinkedAccount = false;
      
      // Asegurarse de cerrar el cliente si se creó parcialmente
      if (tempClient) {
        try {
          await Promise.race([
            tempClient.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
          ]);
          // Esperar que el navegador se cierre
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (closeErr) {
          // Ignorar errores al cerrar, pero esperar de todas formas
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    // Si no tiene cuenta vinculada, eliminar los tokens
    // Esperar un poco más antes de eliminar para asegurar que el navegador se haya cerrado
    if (!hasLinkedAccount) {
      console.log(`🗑️ [${sessionName}] Tokens no tienen cuenta vinculada, eliminando...`);
      // Esperar un momento adicional antes de intentar eliminar
      await new Promise(resolve => setTimeout(resolve, 1000));
      await cleanupSessionTokensWithRetry(sessionName);
      return true; // Tokens eliminados
    }

    return false; // Tokens tienen cuenta vinculada, no se eliminaron
  } catch (err) {
    console.error(`❌ [${sessionName}] Error verificando tokens:`, err.message);
    // En caso de error, eliminar los tokens por seguridad
    console.log(`🗑️ [${sessionName}] Eliminando tokens debido a error en verificación...`);
    // Esperar un momento antes de intentar eliminar
    await new Promise(resolve => setTimeout(resolve, 1000));
    await cleanupSessionTokensWithRetry(sessionName);
    return true;
  }
}

/**
 * Limpia una sesión del mapa de clientes activos
 */
function cleanupSession(sessionName) {
  const sessionData = activeClients.get(sessionName);
  if (sessionData) {
    console.log(`🧹 [${sessionName}] Limpiando sesión del mapa de clientes activos`);
    
    // Limpiar intervalo de actualización de QR si existe
    if (sessionData.qrUpdateInterval) {
      clearInterval(sessionData.qrUpdateInterval);
      sessionData.qrUpdateInterval = null;
    }
    
    activeClients.delete(sessionName);
  }
}

/**
 * Limpia completamente una sesión: tokens, cliente activo y notifica al CRM
 * Esto se ejecuta cuando el QR expira sin ser escaneado o se alcanza el límite de intentos
 */
/**
 * Fuerza el cierre de procesos de Chrome/Chromium relacionados con la sesión
 * @param {string} sessionName - Nombre de la sesión
 */
async function killBrowserProcesses(sessionName) {
  try {
    const tokensPath = path.join(__dirname, '..', 'tokens', sessionName);
    const normalizedPath = tokensPath.replace(/\\/g, '/');
    
    if (process.platform === 'win32') {
      // Windows: buscar procesos de Chrome que usen la carpeta de tokens
      try {
        // Buscar procesos de Chrome/Chromium que puedan estar usando la carpeta
        const { stdout } = await execAsync(
          `tasklist /FI "IMAGENAME eq chrome.exe" /FI "IMAGENAME eq chromium.exe" /FO CSV 2>nul || echo ""`
        );
        
        if (stdout && stdout.includes('chrome.exe')) {
          console.log(`🔪 [${sessionName}] Intentando cerrar procesos de Chrome...`);
          // Intentar cerrar procesos de Chrome de forma más suave primero
          try {
            await execAsync(`taskkill /F /IM chrome.exe /T 2>nul || echo ""`);
            await execAsync(`taskkill /F /IM chromium.exe /T 2>nul || echo ""`);
            console.log(`✅ [${sessionName}] Procesos de Chrome cerrados`);
          } catch (killErr) {
            // Ignorar errores si no hay procesos
          }
        }
      } catch (err) {
        // Ignorar errores en la búsqueda de procesos
      }
    } else {
      // Linux/Mac: usar pkill o killall
      try {
        await execAsync(`pkill -f "chrome.*${sessionName}" || true`);
        await execAsync(`pkill -f "chromium.*${sessionName}" || true`);
      } catch (err) {
        // Ignorar errores
      }
    }
    
    // Esperar un momento para que los procesos se cierren
    await new Promise(resolve => setTimeout(resolve, 2000));
  } catch (err) {
    console.warn(`⚠️ [${sessionName}] Error cerrando procesos del navegador:`, err.message);
  }
}

async function cleanupSessionCompletely(sessionName, reason = 'QR expired') {
  console.log(`🧹 [${sessionName}] Limpiando sesión completamente (razón: ${reason})`);
  
  // 1. Cerrar cliente si existe
  const sessionData = activeClients.get(sessionName);
  if (sessionData && sessionData.client) {
    try {
      console.log(`🔒 [${sessionName}] Cerrando cliente...`);
      await Promise.race([
        sessionData.client.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);
      console.log(`✅ [${sessionName}] Cliente cerrado exitosamente`);
    } catch (err) {
      console.error(`❌ [${sessionName}] Error cerrando cliente:`, err.message);
    }
  }
  
  // 1.5. Forzar cierre de procesos del navegador
  await killBrowserProcesses(sessionName);
  
  // 2. Limpiar del mapa de clientes activos
  cleanupSession(sessionName);
  
  // 3. Esperar un momento antes de eliminar tokens
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // 4. Eliminar tokens (esto elimina la carpeta completa de tokens)
  // IMPORTANTE: Esto asegura que no queden tokens de sesiones no vinculadas
  const tokensDeleted = await cleanupSessionTokensWithRetry(sessionName, 5, 2000);
  if (tokensDeleted) {
    console.log(`✅ [${sessionName}] Tokens eliminados exitosamente de sesión no vinculada`);
  } else {
    console.warn(`⚠️ [${sessionName}] No se pudieron eliminar todos los tokens, pero la sesión fue limpiada`);
  }
  
  // 5. Esperar un momento adicional para asegurar que todo se haya cerrado
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // 6. Notificar al CRM según la razón de limpieza
  try {
    let statusToSend = 'qr_expired';
    if (reason.includes('limit')) {
      statusToSend = 'qr_limit_reached';
    } else if (reason.includes('Manual')) {
      statusToSend = 'cleaned';
    }
    
    await sendQrToCrm(sessionName, null, statusToSend).catch((err) => {
      console.error(`❌ [${sessionName}] Error notificando al CRM:`, err.message);
    });
    console.log(`✅ [${sessionName}] Notificación enviada al CRM (status: ${statusToSend})`);
  } catch (err) {
    console.error(`❌ [${sessionName}] Error notificando limpieza al CRM:`, err.message);
  }
  
  console.log(`✅ [${sessionName}] Sesión limpiada completamente. No se generarán más QRs hasta que el CRM lo solicite.`);
}

/**
 * Verifica si un cliente está realmente conectado
 */
async function isClientConnected(client) {
  try {
    if (!client) return false;
    const state = await client.getConnectionState();
    return state === 'CONNECTED' || state === 'OPENING';
  } catch (error) {
    return false;
  }
}

/**
 * Inicia una sesión de WPPConnect con manejo robusto de errores
 */
function startSession(sessionName) {
  // Evitar iniciar sesiones duplicadas
  if (activeClients.has(sessionName)) {
    const existing = activeClients.get(sessionName);
    if (existing && existing.client) {
      console.log(`ℹ️ [${sessionName}] Sesión ya existe, verificando conexión...`);
      isClientConnected(existing.client).then((connected) => {
        if (connected) {
          console.log(`✅ [${sessionName}] Sesión ya está conectada`);
        } else {
          console.log(`⚠️ [${sessionName}] Sesión existe pero no está conectada, reiniciando...`);
          cleanupSession(sessionName);
          startSessionInternal(sessionName);
        }
      });
      return;
    }
  }

  startSessionInternal(sessionName);
}

/**
 * Implementación interna de inicio de sesión
 */
function startSessionInternal(sessionName) {
  console.log(`🚀 [${sessionName}] Iniciando sesión WPPConnect...`);

  // CRÍTICO: Crear entrada en activeClients ANTES de iniciar la sesión
  // Esto asegura que cuando se genere el QR, sessionData ya exista
  if (!activeClients.has(sessionName)) {
    activeClients.set(sessionName, {
      client: null, // Se asignará cuando el cliente esté listo
      accountPhone: null,
      connectedAt: null,
      state: 'INITIALIZING',
      qrExpiresAt: null,
      qrUpdateInterval: null,
      isConnected: false,
      qrAttempts: 0, // Inicializar contador de intentos QR
    });
    console.log(`📝 [${sessionName}] Entrada creada en activeClients antes de iniciar sesión`);
    console.log(`🔍 [${sessionName}] Verificación: activeClients.has('${sessionName}') = ${activeClients.has(sessionName)}`);
  } else {
    // Si ya existe, resetear contador de intentos QR para nuevo intento
    const existingData = activeClients.get(sessionName);
    if (existingData) {
      existingData.qrAttempts = 0;
      console.log(`🔄 [${sessionName}] Contador de intentos QR reseteado (nueva sesión)`);
    }
  }

  wppconnect
    .create({
      session: sessionName,
      // Opciones según documentación de WPPConnect
      headless: true, // Headless chrome
      devtools: false, // No abrir devtools por defecto
      useChrome: true, // Usar Chrome (no Chromium)
      debug: false, // No abrir sesión de debug
      logQR: false, // No loguear QR en terminal (lo enviamos al CRM)
      browserWS: '', // No usar browserWSEndpoint
      browserArgs: [], // Sin argumentos adicionales del navegador
      puppeteerOptions: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
        headless: true,
        ignoreHTTPSErrors: true,
      },
      disableWelcome: true, // Deshabilitar mensaje de bienvenida
      updatesLog: false, // No loguear actualizaciones automáticamente
      autoClose: 0, // No cerrar automáticamente (manejamos nosotros)
      tokenStore: 'file', // Almacenar tokens en archivos
      folderNameToken: './tokens', // Carpeta para tokens
      // Callback para QR según documentación
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        console.log(`🔍 [${sessionName}] catchQR llamado - intento ${attempts}, sessionName: "${sessionName}"`);
        console.log(`🔍 [${sessionName}] activeClients tiene ${activeClients.size} sesiones`);
        console.log(`🔍 [${sessionName}] Sesiones en activeClients: ${Array.from(activeClients.keys()).join(', ')}`);
        
        // CRÍTICO: Verificar si la sesión ya está conectada antes de generar QR
        const sessionData = activeClients.get(sessionName);
        console.log(`🔍 [${sessionName}] sessionData obtenido: ${sessionData ? 'existe' : 'NO existe'}`);
        
        if (sessionData && sessionData.client) {
          // Verificar si el cliente está realmente conectado
          isClientConnected(sessionData.client).then((connected) => {
            if (connected) {
              console.log(`ℹ️ [${sessionName}] Sesión ya está conectada, ignorando QR generado (intento ${attempts})`);
              return; // No procesar QR si ya está conectado
            }
          }).catch(() => {
            // Si hay error verificando, continuar con el flujo normal
          });
        }
        
        // Asegurar que sessionData existe (debería existir desde startSessionInternal)
        // Si no existe, crearlo como fallback de seguridad
        let sessionDataToUse = sessionData;
        if (!sessionDataToUse) {
          console.warn(`⚠️ [${sessionName}] SessionData no encontrado al generar QR (intento ${attempts}), creando entrada...`);
          console.warn(`⚠️ [${sessionName}] Esto no debería pasar si startSessionInternal se ejecutó correctamente`);
          activeClients.set(sessionName, {
            client: null,
            accountPhone: null,
            connectedAt: null,
            state: 'INITIALIZING',
            qrExpiresAt: null,
            qrUpdateInterval: null,
            isConnected: false,
            qrAttempts: 0,
          });
          sessionDataToUse = activeClients.get(sessionName);
          if (!sessionDataToUse) {
            console.error(`❌ [${sessionName}] Error crítico: No se pudo crear sessionData`);
            return;
          }
          console.log(`✅ [${sessionName}] SessionData creado como fallback`);
        }
        
        // Inicializar contador de intentos QR si no existe
        if (typeof sessionDataToUse.qrAttempts !== 'number') {
          sessionDataToUse.qrAttempts = 0;
        }
        
        const MAX_QR_ATTEMPTS = 3;
        
        // Verificar si ya se alcanzó el límite ANTES de incrementar
        if (sessionDataToUse.qrAttempts >= MAX_QR_ATTEMPTS) {
          console.warn(`⚠️ [${sessionName}] Límite de intentos QR alcanzado (${sessionDataToUse.qrAttempts}/${MAX_QR_ATTEMPTS}). No se generarán más QRs.`);
          console.warn(`🗑️ [${sessionName}] Eliminando tokens de sesión no vinculada...`);
          
          // Cerrar el cliente inmediatamente para evitar que WPPConnect genere más QRs
          if (sessionDataToUse.client) {
            try {
              sessionDataToUse.client.close().catch(() => {});
              console.log(`🔒 [${sessionName}] Cliente cerrado para evitar más QRs`);
            } catch (err) {
              console.warn(`⚠️ [${sessionName}] Error cerrando cliente:`, err.message);
            }
          }
          
          // Notificar al CRM que se alcanzó el límite
          sendQrToCrm(sessionName, null, 'qr_limit_reached').catch((err) => {
            console.error(`❌ [${sessionName}] Error notificando límite de QR al CRM:`, err.message);
          });
          
          // Limpiar sesión completamente (incluye eliminar tokens)
          cleanupSessionCompletely(sessionName, 'QR limit reached - max attempts exceeded').catch((err) => {
            console.error(`❌ [${sessionName}] Error limpiando sesión después de límite:`, err.message);
          });
          
          return; // No procesar este QR
        }
        
        // Incrementar contador de intentos QR DESPUÉS de verificar
        sessionDataToUse.qrAttempts++;
        
        console.log(
          `📱 [${sessionName}] QR generado (intento ${sessionDataToUse.qrAttempts}/${MAX_QR_ATTEMPTS}). Escanea con WhatsApp Business:`
        );
        if (process.env.LOG_QR_ASCII === 'true') {
        console.log(asciiQR);
        }
        if (urlCode) {
          console.log(`🔗 [${sessionName}] URL Code (data-ref): ${urlCode}`);
        }
        
        // El QR de WhatsApp expira después de aproximadamente 20 segundos
        // Pero WPPConnect puede regenerarlo automáticamente
        // Configuramos 60 segundos como tiempo máximo de espera
        const QR_TIMEOUT_SECONDS = 60;
        const qrExpiresAt = Date.now() + (QR_TIMEOUT_SECONDS * 1000);
        
        // Enviar QR al CRM con información de expiración
        sendQrToCrmWithExpiration(sessionName, base64Qr, 'waiting_qr', QR_TIMEOUT_SECONDS, qrExpiresAt, QR_TIMEOUT_SECONDS).catch((err) => {
          console.error(`❌ [${sessionName}] Error enviando QR:`, err.message);
        });
        
        // Guardar información de expiración para configurar el intervalo después
        // cuando el cliente esté en el mapa
        const qrInfo = {
          expiresAt: qrExpiresAt,
          timeoutSeconds: QR_TIMEOUT_SECONDS,
        };
        
        // Configurar el intervalo después de un pequeño delay para asegurar que el cliente esté en el mapa
        setTimeout(() => {
          const sessionDataForInterval = activeClients.get(sessionName);
          if (sessionDataForInterval) {
            // Si el cliente ya está asignado, verificar conexión
            if (sessionDataForInterval.client) {
              isClientConnected(sessionDataForInterval.client).then((connected) => {
                if (!connected) {
                  setupQrUpdateInterval(sessionName, qrInfo);
                } else {
                  console.log(`ℹ️ [${sessionName}] Sesión conectada, no se configurará intervalo de QR`);
                }
              }).catch(() => {
                // Si hay error, configurar intervalo por seguridad
                setupQrUpdateInterval(sessionName, qrInfo);
              });
            } else {
              // Si el cliente aún no está asignado, configurar intervalo de todas formas
              // El cliente se asignará después y el intervalo funcionará
              setupQrUpdateInterval(sessionName, qrInfo);
            }
          } else {
            // Si el sessionData aún no existe, intentar de nuevo después
            setTimeout(() => {
              const sessionDataRetry = activeClients.get(sessionName);
              if (sessionDataRetry) {
                if (sessionDataRetry.client) {
                  isClientConnected(sessionDataRetry.client).then((connected) => {
                    if (!connected) {
                      setupQrUpdateInterval(sessionName, qrInfo);
                    }
                  }).catch(() => {
                    setupQrUpdateInterval(sessionName, qrInfo);
                  });
                } else {
                  setupQrUpdateInterval(sessionName, qrInfo);
                }
              }
            }, 1000);
          }
        }, 500);
      },
      // Callback para estados según documentación
      // Status puede ser: isLogged, notLogged, browserClose, qrReadSuccess, qrReadFail, 
      // autocloseCalled, desconnectedMobile, serverClose, deleteToken
      statusFind: async (statusSession, session) => {
        console.log(`ℹ️ [${sessionName}] Estado de sesión: ${statusSession}`);
        
        // Actualizar estado en el mapa
        const sessionData = activeClients.get(sessionName);
        if (sessionData) {
          sessionData.state = statusSession;
        }

        // Manejar estados según documentación de WPPConnect
        // CRÍTICO: 'inChat' también indica que está conectado (según logs del usuario)
        if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess' || statusSession === 'inChat') {
          // Usuario conectado exitosamente
          console.log(`✅ [${sessionName}] Sesión conectada exitosamente (estado: ${statusSession})`);
          
          // Limpiar intervalo de actualización de QR cuando se conecta
          if (sessionData && sessionData.qrUpdateInterval) {
            clearInterval(sessionData.qrUpdateInterval);
            sessionData.qrUpdateInterval = null;
            console.log(`🧹 [${sessionName}] Intervalo de QR limpiado`);
          }
          
          // Resetear contador de intentos QR cuando se conecta exitosamente
          if (sessionData) {
            sessionData.qrAttempts = 0;
            console.log(`🔄 [${sessionName}] Contador de intentos QR reseteado (conexión exitosa)`);
          }
          
          // CRÍTICO: Enviar estado 'connected' al CRM para que actualice isPending: false
          console.log(`📤 [${sessionName}] statusFind: Enviando señal 'connected' al CRM para actualizar isPending: false`);
          
          // Intentar obtener accountPhone antes de enviar si no está disponible
          if (!sessionData?.accountPhone && sessionData?.client) {
            try {
              const hostDevice = await sessionData.client.getHostDevice();
              const phone = hostDevice?.wid?.user || hostDevice?.wid || null;
              if (phone && sessionData) {
                sessionData.accountPhone = phone;
                console.log(`📱 [${sessionName}] accountPhone obtenido: ${phone}`);
              }
            } catch (err) {
              console.warn(`⚠️ [${sessionName}] No se pudo obtener accountPhone:`, err.message);
            }
          }
          
          sendQrToCrm(sessionName, null, 'connected')
            .then((response) => {
              console.log(`✅ [${sessionName}] Señal 'connected' enviada exitosamente desde statusFind. Respuesta:`, JSON.stringify(response, null, 2));
            })
            .catch((err) => {
              console.error(`❌ [${sessionName}] ERROR CRÍTICO enviando 'connected' desde statusFind:`, err.message);
              // Reintentar después de 3 segundos
              setTimeout(() => {
                console.log(`🔄 [${sessionName}] Reintentando envío de 'connected' desde statusFind...`);
                sendQrToCrm(sessionName, null, 'connected').catch((retryErr) => {
                  console.error(`❌ [${sessionName}] Error en reintento desde statusFind:`, retryErr.message);
                });
              }, 3000);
            });
          
          // Marcar que la sesión está conectada para evitar generar más QRs
          if (sessionData) {
            sessionData.isConnected = true;
          }
        } else if (statusSession === 'notLogged') {
          // Usuario no está conectado, necesita escanear QR
          // No hacer nada, el QR se enviará cuando se genere
        } else if (statusSession === 'browserClose') {
          // Navegador cerrado
          console.warn(`⚠️ [${sessionName}] Navegador cerrado`);
          sendQrToCrm(sessionName, null, 'disconnected').catch((err) => {
            console.error(`❌ [${sessionName}] Error enviando estado disconnected:`, err.message);
          });
          cleanupSession(sessionName);
        } else if (statusSession === 'qrReadFail') {
          // Fallo al leer QR
          console.warn(`⚠️ [${sessionName}] Fallo al leer QR`);
          // No limpiar, puede regenerarse
        } else if (statusSession === 'autocloseCalled') {
          // Auto-close llamado (no debería pasar con autoClose: 0)
          console.warn(`⚠️ [${sessionName}] Auto-close llamado`);
        } else if (statusSession === 'desconnectedMobile') {
          // Desconectado del móvil
          console.warn(`⚠️ [${sessionName}] Desconectado del móvil`);
          sendQrToCrm(sessionName, null, 'disconnected').catch((err) => {
            console.error(`❌ [${sessionName}] Error enviando estado disconnected:`, err.message);
          });
          cleanupSession(sessionName);
        } else if (statusSession === 'serverClose') {
          // Servidor WSS cerrado
          console.warn(`⚠️ [${sessionName}] Servidor WSS cerrado`);
          sendQrToCrm(sessionName, null, 'disconnected').catch((err) => {
            console.error(`❌ [${sessionName}] Error enviando estado disconnected:`, err.message);
          });
          cleanupSession(sessionName);
        } else if (statusSession === 'deleteToken') {
          // Token eliminado
          console.warn(`⚠️ [${sessionName}] Token eliminado`);
          cleanupSession(sessionName);
        }
      },
    })
    .then(async (client) => {
      console.log(`✅ [${sessionName}] Cliente WPPConnect inicializado`);

      // Obtener información de la cuenta según documentación
      let accountPhone = null;
      try {
        // getHostDevice() retorna información del dispositivo host
        const hostDevice = await client.getHostDevice();
        accountPhone = hostDevice?.wid?.user || hostDevice?.wid || null;
        if (accountPhone) {
          console.log(`📱 [${sessionName}] Cuenta vinculada: ${accountPhone}`);
        } else {
          // Intentar obtener de otra manera
          try {
            const numberId = await client.getNumberId();
            if (numberId) {
              accountPhone = extractPhoneFromId(numberId);
              console.log(`📱 [${sessionName}] Cuenta obtenida de getNumberId: ${accountPhone}`);
            }
          } catch (err2) {
            console.warn(`⚠️ [${sessionName}] No se pudo obtener número de cuenta de getNumberId:`, err2.message);
          }
        }
      } catch (err) {
        console.warn(`⚠️ [${sessionName}] No se pudo obtener número de cuenta:`, err.message);
        // Intentar obtener después de un delay cuando la sesión esté completamente conectada
        setTimeout(async () => {
          try {
            const hostDevice = await client.getHostDevice();
            const phone = hostDevice?.wid?.user || hostDevice?.wid || null;
            if (phone) {
              const sessionData = activeClients.get(sessionName);
              if (sessionData) {
                sessionData.accountPhone = phone;
                console.log(`📱 [${sessionName}] Cuenta actualizada: ${phone}`);
              }
            }
          } catch (retryErr) {
            console.warn(`⚠️ [${sessionName}] Error en reintento de obtener número:`, retryErr.message);
          }
        }, 5000);
      }

      // Actualizar cliente activo con información adicional
      // Si ya existe sessionData (creado en startSessionInternal), actualizarlo
      // Si no existe, crearlo (fallback de seguridad)
      const existingSessionData = activeClients.get(sessionName);
      if (existingSessionData) {
        // Actualizar datos existentes manteniendo el contador de intentos QR
        existingSessionData.client = client;
        existingSessionData.accountPhone = accountPhone;
        existingSessionData.connectedAt = new Date();
        existingSessionData.state = 'CONNECTED';
        // Mantener qrAttempts si ya existe, sino inicializar en 0
        if (typeof existingSessionData.qrAttempts !== 'number') {
          existingSessionData.qrAttempts = 0;
        }
        console.log(`✅ [${sessionName}] Cliente actualizado en sessionData existente (qrAttempts: ${existingSessionData.qrAttempts})`);
      } else {
        // Crear nuevo si no existe (no debería pasar, pero por seguridad)
        activeClients.set(sessionName, {
          client,
          accountPhone,
          connectedAt: new Date(),
          state: 'CONNECTED',
          qrExpiresAt: null,
          qrUpdateInterval: null,
          isConnected: false,
          qrAttempts: 0,
        });
        console.log(`⚠️ [${sessionName}] Cliente creado en nuevo sessionData (no debería pasar)`);
      }
      
      // Si hay información de QR pendiente, configurar el intervalo
      // Esto puede pasar si el QR se generó antes de que el cliente estuviera en el mapa
      // (aunque normalmente no debería pasar, es una medida de seguridad)

      // Manejar cambios de estado según documentación
      // onStateChange se dispara cuando cambia el estado de conexión
      client.onStateChange(async (state) => {
        console.log(`🔁 [${sessionName}] Cambio de estado: ${state}`);
        
        const sessionData = activeClients.get(sessionName);
        if (sessionData) {
          sessionData.state = state;
        }

        // Estados según documentación de WPPConnect
        if (state === 'DISCONNECTED') {
          console.warn(`⚠️ [${sessionName}] Sesión desconectada, limpiando...`);
          
          try {
            await client.close();
          } catch (err) {
            console.error(`❌ [${sessionName}] Error cerrando cliente:`, err.message);
          }
          
          cleanupSession(sessionName);
          
          // Notificar al CRM
          sendQrToCrm(sessionName, null, 'disconnected').catch((err) => {
            console.error(`❌ [${sessionName}] Error notificando desconexión:`, err.message);
          });

          // NO reconectar automáticamente cuando se desconecta
          // El CRM debe solicitar explícitamente un nuevo QR si es necesario
          console.log(`ℹ️ [${sessionName}] Sesión desconectada. No se reintentará automáticamente.`);
          console.log(`ℹ️ [${sessionName}] Para reconectar, solicita un nuevo QR desde el CRM.`);
        } else if (state === 'CONFLICT') {
          // Conflicto de sesión (múltiples dispositivos)
          console.warn(`⚠️ [${sessionName}] Conflicto de sesión detectado (múltiples dispositivos)`);
          
          try {
            await client.close();
          } catch (err) {
            console.error(`❌ [${sessionName}] Error cerrando cliente:`, err.message);
          }
          
          cleanupSession(sessionName);
          
          // Notificar al CRM
          sendQrToCrm(sessionName, null, 'disconnected').catch((err) => {
            console.error(`❌ [${sessionName}] Error notificando conflicto:`, err.message);
          });
        } else if (state === 'CONNECTED' || state === 'OPENING') {
          // Sesión conectada o conectándose
          console.log(`✅ [${sessionName}] Sesión ${state === 'CONNECTED' ? 'conectada' : 'conectándose'}`);
          
          // CRÍTICO: Si el estado es 'CONNECTED', enviar señal al CRM para actualizar isPending: false
          if (state === 'CONNECTED') {
            // Limpiar intervalo de actualización de QR si existe
            if (sessionData && sessionData.qrUpdateInterval) {
              clearInterval(sessionData.qrUpdateInterval);
              sessionData.qrUpdateInterval = null;
              console.log(`🧹 [${sessionName}] Intervalo de QR limpiado`);
            }
            
            // Marcar como conectado para evitar generar más QRs
            if (sessionData) {
              sessionData.isConnected = true;
              // Resetear contador de intentos QR cuando se conecta
              sessionData.qrAttempts = 0;
              console.log(`🔄 [${sessionName}] Contador de intentos QR reseteado (estado CONNECTED)`);
            }
            
            // CRÍTICO: Enviar estado 'connected' al CRM para que actualice isPending: false
            console.log(`📤 [${sessionName}] onStateChange CONNECTED: Enviando señal 'connected' al CRM para actualizar isPending: false`);
            
            // Intentar obtener accountPhone antes de enviar si no está disponible
            if (!sessionData?.accountPhone && sessionData?.client) {
              (async () => {
                try {
                  const hostDevice = await sessionData.client.getHostDevice();
                  const phone = hostDevice?.wid?.user || hostDevice?.wid || null;
                  if (phone && sessionData) {
                    sessionData.accountPhone = phone;
                    console.log(`📱 [${sessionName}] accountPhone obtenido: ${phone}`);
                  }
                } catch (err) {
                  console.warn(`⚠️ [${sessionName}] No se pudo obtener accountPhone:`, err.message);
                }
              })();
            }
            
            sendQrToCrm(sessionName, null, 'connected')
              .then((response) => {
                console.log(`✅ [${sessionName}] Señal 'connected' enviada exitosamente desde onStateChange. Respuesta:`, JSON.stringify(response, null, 2));
              })
              .catch((err) => {
                console.error(`❌ [${sessionName}] ERROR CRÍTICO enviando 'connected' desde onStateChange:`, err.message);
                // Reintentar después de 3 segundos
                setTimeout(() => {
                  console.log(`🔄 [${sessionName}] Reintentando envío de 'connected' desde onStateChange...`);
                  sendQrToCrm(sessionName, null, 'connected').catch((retryErr) => {
                    console.error(`❌ [${sessionName}] Error en reintento desde onStateChange:`, retryErr.message);
                  });
                }, 3000);
              });
          }
          
          // Actualizar accountPhone si no está disponible
          if (!sessionData?.accountPhone) {
            try {
              const hostDevice = await client.getHostDevice();
              const phone = hostDevice?.wid?.user || hostDevice?.wid || null;
              if (phone && sessionData) {
                sessionData.accountPhone = phone;
                console.log(`📱 [${sessionName}] Cuenta actualizada: ${phone}`);
              }
            } catch (err) {
              console.warn(`⚠️ [${sessionName}] No se pudo actualizar número de cuenta:`, err.message);
            }
          }
        }
      });

      // Manejar cambios de stream según documentación
      // onStreamChange se dispara cuando cambia el stream de conexión
      client.onStreamChange((stream) => {
        console.log(`📡 [${sessionName}] Cambio de stream: ${stream}`);
        
        // CRÍTICO: Si el stream es 'CONNECTED', enviar señal al CRM
        if (stream === 'CONNECTED') {
          const sessionData = activeClients.get(sessionName);
          if (sessionData && !sessionData.isConnected) {
            console.log(`✅ [${sessionName}] Stream CONNECTED detectado, enviando señal al CRM`);
            sessionData.isConnected = true;
            
            // Limpiar intervalo de QR si existe
            if (sessionData.qrUpdateInterval) {
              clearInterval(sessionData.qrUpdateInterval);
              sessionData.qrUpdateInterval = null;
            }
            
            // Resetear contador de intentos QR cuando se conecta
            sessionData.qrAttempts = 0;
            console.log(`🔄 [${sessionName}] Contador de intentos QR reseteado (stream CONNECTED)`);
            
            // Enviar estado 'connected' al CRM para actualizar isPending: false
            console.log(`📤 [${sessionName}] onStreamChange CONNECTED: Enviando señal 'connected' al CRM para actualizar isPending: false`);
            sendQrToCrm(sessionName, null, 'connected')
              .then((response) => {
                console.log(`✅ [${sessionName}] Señal 'connected' enviada exitosamente desde onStreamChange. Respuesta:`, JSON.stringify(response, null, 2));
              })
              .catch((err) => {
                console.error(`❌ [${sessionName}] ERROR CRÍTICO enviando 'connected' desde onStreamChange:`, err.message);
                // Reintentar después de 3 segundos
                setTimeout(() => {
                  console.log(`🔄 [${sessionName}] Reintentando envío de 'connected' desde onStreamChange...`);
                  sendQrToCrm(sessionName, null, 'connected').catch((retryErr) => {
                    console.error(`❌ [${sessionName}] Error en reintento desde onStreamChange:`, retryErr.message);
                  });
                }, 3000);
              });
          }
        }
        
        // Si el stream se cierra, puede indicar desconexión
        if (stream === 'DISCONNECTED' || stream === 'CLOSED') {
          console.warn(`⚠️ [${sessionName}] Stream desconectado: ${stream}`);
        }
      });

      // Manejar mensajes según documentación de WPPConnect
      // onAnyMessage captura TODOS los mensajes (entrantes y salientes)
      // También podemos usar onMessage para solo mensajes entrantes, pero onAnyMessage es más completo
      client.onAnyMessage(async (message) => {
        try {
          // Ignorar grupos (solo procesar mensajes individuales)
          if (message.isGroupMsg === true) {
            return;
          }

          // Determinar dirección según documentación
          const fromMe = message.fromMe === true;
          const direction = fromMe ? 'outbound' : 'inbound';

          // Extraer IDs según estructura de WPPConnect
          const accountId = fromMe ? (message.from || message.to) : message.to;
          const contactId = fromMe ? message.to : (message.from || message.to);

          const accountPhone = extractPhoneFromId(accountId);
          const contactPhone = extractPhoneFromId(contactId);

          // Log para debugging: ver el formato exacto que viene de WhatsApp
          console.log(`🔍 [${sessionName}] Formato de número de WhatsApp:`);
          console.log(`   - accountId original: ${accountId}`);
          console.log(`   - contactId original: ${contactId}`);
          console.log(`   - accountPhone extraído: ${accountPhone}`);
          console.log(`   - contactPhone extraído: ${contactPhone}`);

          // Validar números
          if (!isValidPhoneNumber(contactPhone)) {
            console.warn(`⚠️ [${sessionName}] Número de teléfono inválido: ${contactPhone}`);
            return;
          }

          // Obtener nombre del contacto según documentación
          // IMPORTANTE:
          // - Para mensajes salientes (fromMe === true), message.sender suele ser la CUENTA (ej. "Jorge Zanabria")
          //   y message.chat/name/notifyName suelen corresponder al CONTACTO.
          // - Para mensajes entrantes, sender suele ser el contacto.
          // Para evitar que el nombre de la cuenta vinculada aparezca como nombre del contacto en el CRM,
          // priorizamos distintos campos según la dirección del mensaje.
          let contactName;
          if (fromMe) {
            // Mensaje enviado DESDE la cuenta al contacto:
            // preferir siempre el nombre del chat/contacto.
            contactName =
              message.chat?.name ||
              message.notifyName ||
              message.sender?.pushname ||
              message.sender?.name ||
              contactPhone;
          } else {
            // Mensaje entrante DESDE el contacto hacia la cuenta:
            // el sender suele ser el contacto, así que lo priorizamos.
            contactName =
              message.sender?.pushname ||
              message.sender?.name ||
              message.chat?.name ||
              message.notifyName ||
              contactPhone;
          }

          // Procesar texto del mensaje
          // WPPConnect puede enviar diferentes tipos de mensajes
          let messageText = '';
          let messageType = 'text';
          
          if (message.body) {
            messageText = message.body;
            messageType = 'text';
          } else if (message.type === 'image' || message.type === 'video' || message.type === 'document') {
            // Para mensajes multimedia, usar caption si está disponible
            messageText = message.caption || message.body || '[Mensaje multimedia]';
            messageType = message.type;
          } else if (message.type === 'location') {
            messageText = `📍 Ubicación: ${message.lat}, ${message.lng}`;
            messageType = 'location';
          } else if (message.type === 'ptv') {
            messageText = message.caption || '[Video temporal]';
            messageType = 'ptv';
          } else {
            // Otros tipos de mensajes
            messageText = message.body || `[${message.type || 'unknown'}]`;
            messageType = message.type || 'unknown';
          }

          // Solo procesar mensajes con contenido (texto o multimedia)
          if (!messageText && !message.type) {
            return;
          }

          // Procesar timestamp según documentación
          // WPPConnect puede enviar timestamp en segundos o milisegundos
          let timestampMs = Date.now();
          if (message.timestamp) {
            if (typeof message.timestamp === 'number') {
              // Si es menor que un timestamp de 2020, asumir que está en segundos
              if (message.timestamp < 1577836800000) {
                timestampMs = message.timestamp * 1000;
              } else {
                timestampMs = message.timestamp;
              }
            } else if (message.timestamp.low) {
              // Timestamp de Firestore
              timestampMs = message.timestamp.low * 1000;
            }
          }

          // Obtener accountPhone del cliente si no está en el mensaje
          const finalAccountPhone = accountPhone || activeClients.get(sessionName)?.accountPhone || '';

          const payload = {
            sessionId: sessionName,
            accountPhone: finalAccountPhone,
            contactPhone,
            contactName,
            messageText: messageText || '[Sin contenido]',
            messageType,
            direction,
            messageId: message.id?._serialized || message.id || message.msgId || null,
            timestamp: timestampMs,
            // Información adicional del mensaje
            isForwarded: message.isForwarded === true,
            isStarred: message.isStarred === true,
            hasMedia: !!(message.mediaKey || message.mimetype),
            mediaType: message.mimetype || null,
          };

          console.log(
            `📨 [${sessionName}] Mensaje ${direction} (${messageType}) ${contactPhone} <-[${finalAccountPhone || 'unknown'}]: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`
          );

          // Enviar al CRM (no bloquear si falla)
          sendToCrm(payload).catch((err) => {
            console.error(`❌ [${sessionName}] Error enviando mensaje al CRM:`, err.message);
          });
        } catch (err) {
          console.error(`❌ [${sessionName}] Error procesando mensaje:`, err.message);
          console.error(`❌ [${sessionName}] Stack trace:`, err.stack);
        }
      });
    })
    .catch((error) => {
      console.error(`❌ [${sessionName}] Error iniciando WPPConnect:`, error.message || error);
      console.error(`❌ [${sessionName}] Stack trace:`, error.stack);
      
      // Limpiar sesión en caso de error
      cleanupSession(sessionName);
      
      // Notificar al CRM del error
      sendQrToCrm(sessionName, null, 'error').catch((err) => {
        console.error(`❌ [${sessionName}] Error notificando error al CRM:`, err.message);
      });
      
      // NO reintentar automáticamente - el CRM debe solicitar explícitamente un nuevo QR
      // Esto previene loops infinitos de reconexión
      console.log(`ℹ️ [${sessionName}] Error al iniciar sesión. No se reintentará automáticamente.`);
      console.log(`ℹ️ [${sessionName}] Para reintentar, solicita un nuevo QR desde el CRM.`);
      
      // Manejar errores específicos según documentación
      if (error.message?.includes('browser') || error.message?.includes('puppeteer')) {
        console.error(`❌ [${sessionName}] Error del navegador/Puppeteer. Verifica la configuración.`);
      } else if (error.message?.includes('timeout')) {
        console.error(`❌ [${sessionName}] Timeout al iniciar sesión.`);
      } else if (error.message?.includes('token')) {
        console.error(`❌ [${sessionName}] Error con tokens. Limpiando tokens...`);
        cleanupSessionTokens(sessionName);
      }
    });
}

// ============================================================================
// SERVIDOR HTTP
// ============================================================================

const app = express();
app.use(express.json({ limit: '10mb' })); // Limitar tamaño de payload

// Middleware de logging
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`);
  next();
});

// Healthcheck mejorado
app.get('/health', (_req, res) => {
  const activeSessions = Array.from(activeClients.keys());
  res.json({
    ok: true,
    status: 'whatsapp-web-sync-service running',
    activeSessions: activeSessions.length,
    sessions: activeSessions,
    timestamp: new Date().toISOString(),
  });
});

// Endpoint para obtener estado de sesiones
app.get('/sessions', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.substring('Bearer '.length)
    : authHeader;

  if (token !== CRM_SYNC_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sessions = Array.from(activeClients.entries()).map(([sessionId, data]) => ({
    sessionId,
    accountPhone: data.accountPhone,
    connectedAt: data.connectedAt,
    state: data.state,
    isConnected: !!data.client,
  }));

  res.json({ sessions });
});

// Endpoint para solicitar QR
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

  // Normalizar el sessionId igual que en el CRM (remover caracteres especiales excepto guiones y guiones bajos)
  // Esto asegura consistencia entre el CRM y el microservicio
  let trimmedSessionId = sessionId.trim();
  const normalizedSessionId = trimmedSessionId.replace(/[^a-zA-Z0-9_\-]/g, '');
  
  if (normalizedSessionId !== trimmedSessionId) {
    console.log(`ℹ️ [${trimmedSessionId}] Nombre de sesión normalizado: "${trimmedSessionId}" -> "${normalizedSessionId}"`);
    trimmedSessionId = normalizedSessionId;
  }
  
  if (!trimmedSessionId || trimmedSessionId.length < 3) {
    return res.status(400).json({ 
      error: 'Invalid sessionId',
      details: 'El ID de sesión debe tener al menos 3 caracteres después de normalizar (solo letras, números, guiones y guiones bajos)'
    });
  }

  console.log(`📥 [${trimmedSessionId}] Petición del CRM para iniciar sesión y generar QR`);

  // Limpiar tokens si existen y no hay sesión activa conectada
  // Simplificado: si hay tokens pero no hay sesión activa, eliminarlos directamente
  // Esto evita problemas de navegadores bloqueados y es más rápido
  const tokensPath = path.join(__dirname, '..', 'tokens', trimmedSessionId);
  if (fs.existsSync(tokensPath)) {
    // Si no hay sesión activa o la sesión no está conectada, eliminar tokens
    if (!activeClients.has(trimmedSessionId)) {
      console.log(`🗑️ [${trimmedSessionId}] Eliminando tokens existentes (no hay sesión activa)...`);
      try {
        const removed = await cleanupSessionTokensWithRetry(trimmedSessionId, 2, 1000); // Menos reintentos, más rápido
        if (removed) {
          console.log(`✅ [${trimmedSessionId}] Tokens eliminados`);
          // Esperar un momento para asegurar que el sistema de archivos se actualice
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (err) {
        console.warn(`⚠️ [${trimmedSessionId}] No se pudieron eliminar todos los tokens, continuando de todas formas:`, err.message);
      }
    } else {
      // Si hay sesión activa, verificar si está conectada
      const sessionData = activeClients.get(trimmedSessionId);
      if (sessionData && sessionData.client) {
        try {
          const isConnected = await isClientConnected(sessionData.client);
          if (!isConnected) {
            console.log(`🗑️ [${trimmedSessionId}] Sesión existe pero no está conectada, eliminando tokens...`);
            const removed = await cleanupSessionTokensWithRetry(trimmedSessionId, 2, 1000);
            if (removed) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        } catch (err) {
          console.warn(`⚠️ [${trimmedSessionId}] Error verificando conexión, eliminando tokens por seguridad:`, err.message);
          const removed = await cleanupSessionTokensWithRetry(trimmedSessionId, 2, 1000);
          if (removed) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } else {
        // Sesión existe pero no tiene cliente, eliminar tokens
        console.log(`🗑️ [${trimmedSessionId}] Sesión existe pero no tiene cliente, eliminando tokens...`);
        const removed = await cleanupSessionTokensWithRetry(trimmedSessionId, 2, 1000);
        if (removed) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  // Si la sesión ya existe y está activa, verificar si está conectada
  if (activeClients.has(trimmedSessionId)) {
    const sessionData = activeClients.get(trimmedSessionId);
    if (sessionData && sessionData.client) {
      // Verificar si está realmente conectada
      const isConnected = await isClientConnected(sessionData.client);
      if (isConnected) {
        console.log(`ℹ️ [${trimmedSessionId}] Sesión ya está conectada, no se generará un nuevo QR`);
        return res.json({
          ok: true,
          message: 'Sesión ya está conectada. Si necesitas un nuevo QR, cancela la sesión actual primero.',
          sessionId: trimmedSessionId,
        });
      } else {
        // Sesión existe pero no está conectada, limpiar y generar nuevo QR
        console.log(`ℹ️ [${trimmedSessionId}] Sesión existe pero no está conectada, limpiando y generando nuevo QR`);
        cleanupSession(trimmedSessionId);
        // Los tokens ya fueron verificados y limpiados arriba si no tenían cuenta vinculada
        // Pero si la sesión existe pero no está conectada, también limpiar tokens por seguridad
        cleanupSessionTokens(trimmedSessionId);
      }
    } else {
      // Limpiar si existe pero no tiene cliente
      cleanupSession(trimmedSessionId);
    }
  }

  // Resetear contador de intentos QR cuando se solicita un nuevo QR desde el CRM
  // Esto permite que el usuario pueda intentar vincular nuevamente después de limpiar
  const existingSessionData = activeClients.get(trimmedSessionId);
  if (existingSessionData) {
    existingSessionData.qrAttempts = 0;
    console.log(`🔄 [${trimmedSessionId}] Contador de intentos QR reseteado (nueva solicitud desde CRM)`);
  }

  // Iniciar la sesión (esto generará el QR)
  startSession(trimmedSessionId);

  return res.json({
    ok: true,
    message: 'Sesión iniciada. El QR se generará y se enviará al CRM cuando esté disponible.',
    sessionId: trimmedSessionId,
  });
});

// Endpoint para enviar mensajes
app.post('/sessions/:sessionId/send', async (req, res) => {
  const { sessionId } = req.params;
  const { phoneNumber, message } = req.body;

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

  if (!phoneNumber || !message) {
    return res.status(400).json({ error: 'phoneNumber and message are required' });
  }

  const trimmedSessionId = sessionId.trim();
  const sessionData = activeClients.get(trimmedSessionId);

  if (!sessionData || !sessionData.client) {
    return res.status(404).json({
      error: 'Session not found or not active',
      details: 'La sesión debe estar conectada antes de enviar mensajes',
    });
  }

  // Verificar que el cliente esté realmente conectado
  const isConnected = await isClientConnected(sessionData.client);
  if (!isConnected) {
    cleanupSession(trimmedSessionId);
    return res.status(400).json({
      error: 'Session not connected',
      details: 'La sesión no está conectada. Por favor, reconecta la sesión.',
    });
  }

  // Validar número de teléfono
  if (!isValidPhoneNumber(phoneNumber)) {
    return res.status(400).json({
      error: 'Invalid phone number',
      details: 'El número de teléfono no tiene un formato válido',
    });
  }

  try {
    // Normalizar número de teléfono
    // IMPORTANTE: WhatsApp puede usar números con o sin código de país
    // Debemos usar el número tal como viene, pero asegurarnos de que tenga el formato correcto
    let normalizedPhone = normalizePhoneNumber(phoneNumber);
    
    // Si el número tiene código de país (52 para México), verificar si WhatsApp lo espera con o sin él
    // Por defecto, WhatsApp Web usa números con código de país
    // Si no tiene @, agregarlo
    if (!normalizedPhone.includes('@')) {
      normalizedPhone = `${normalizedPhone}@c.us`;
    }

    console.log(`📤 [${trimmedSessionId}] Enviando mensaje:`);
    console.log(`   - Número original recibido: ${phoneNumber}`);
    console.log(`   - Número normalizado: ${normalizedPhone}`);

    // Enviar mensaje usando WPPConnect según documentación
    // sendText retorna una Promise con el resultado
    let result;
    try {
      result = await sessionData.client.sendText(normalizedPhone, message);
    } catch (sendError) {
      // Si falla sendText, intentar con sendMessageOptions como fallback
      console.warn(`⚠️ [${trimmedSessionId}] sendText falló, intentando método alternativo:`, sendError.message);
      try {
        result = await sessionData.client.sendMessageOptions(normalizedPhone, message, {
          delay: 1000,
        });
      } catch (altError) {
        throw sendError; // Lanzar el error original
      }
    }

    // Extraer messageId según estructura de respuesta de WPPConnect
    const messageId = result?.id?._serialized || 
                      result?.id || 
                      result?.messageId?._serialized ||
                      result?.messageId ||
                      result?._serialized || 
                      null;

    console.log(`✅ [${trimmedSessionId}] Mensaje enviado exitosamente (ID: ${messageId})`);

    return res.json({
      success: true,
      messageId,
      sessionId: trimmedSessionId,
      result: result ? {
        id: messageId,
        ack: result.ack,
        sendMsgResult: result.sendMsgResult,
      } : null,
    });
  } catch (error) {
    console.error(`❌ [${trimmedSessionId}] Error enviando mensaje:`, error.message || error);

    // Manejar errores específicos de WPPConnect
    let errorMessage = 'Error sending message';
    let statusCode = 500;

    if (error.message?.includes('not logged in') || error.message?.includes('not connected')) {
      errorMessage = 'Session not connected';
      statusCode = 400;
      cleanupSession(trimmedSessionId);
    } else if (error.message?.includes('invalid number') || error.message?.includes('invalid')) {
      errorMessage = 'Invalid phone number';
      statusCode = 400;
    }

    return res.status(statusCode).json({
      error: errorMessage,
      details: error.message || 'Unknown error',
    });
  }
});

// Endpoint para limpiar completamente una sesión (tokens, cliente, etc.)
app.delete('/sessions/:sessionId/cleanup', async (req, res) => {
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

  const trimmedSessionId = sessionId.trim();

  console.log(`🧹 [${trimmedSessionId}] Limpieza completa solicitada desde CRM`);

  try {
    // Limpiar completamente la sesión
    await cleanupSessionCompletely(trimmedSessionId, 'Manual cleanup requested from CRM');
    
    // Esperar un momento adicional para asegurar que todo se haya cerrado
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Intentar eliminar tokens nuevamente con reintentos por si acaso
    await cleanupSessionTokensWithRetry(trimmedSessionId, 5, 2000);
    
    // Forzar cierre de procesos del navegador una vez más
    await killBrowserProcesses(trimmedSessionId);
    
    // Esperar un momento final
    await new Promise(resolve => setTimeout(resolve, 2000));

    return res.json({
      ok: true,
      message: `Sesión "${trimmedSessionId}" limpiada completamente. IMPORTANTE: Espera al menos 10-15 minutos antes de intentar vincular nuevamente. WhatsApp puede bloquear la vinculación si hay demasiados intentos en poco tiempo.`,
      sessionId: trimmedSessionId,
      recommendation: 'Espera 10-15 minutos antes de intentar vincular nuevamente para evitar bloqueos temporales de WhatsApp.',
    });
  } catch (error) {
    console.error(`❌ [${trimmedSessionId}] Error en limpieza completa:`, error.message);
    return res.status(500).json({
      error: 'Error cleaning up session',
      message: error.message,
    });
  }
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('❌ Error no manejado:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP escuchando en el puerto ${PORT}`);
  console.log(`📋 Healthcheck disponible en http://localhost:${PORT}/health`);
});

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

console.log('🚀 Preparando cliente(s) de WhatsApp (WPPConnect)...');

/**
 * Inicializa las sesiones al arrancar
 * IMPORTANTE: Solo inicia sesiones que ya están conectadas (status: 'connected')
 * NO genera QRs automáticamente - los QRs solo se generan cuando el CRM lo solicita
 */
async function bootstrap() {
  try {
    // Intentar cargar solo sesiones conectadas desde el CRM
  let sessions = await loadSessionsFromCrm();

  if (!sessions || sessions.length === 0) {
    console.log(
        'ℹ️ No se encontraron sesiones conectadas en CRM. ' +
          'Las sesiones solo se iniciarán cuando el CRM solicite explícitamente un QR. ' +
        'Crea sesiones en la colección "whatsapp_web_sessions" desde el panel de administración del CRM ' +
          'y solicita el QR desde el CRM para iniciar el proceso de vinculación.'
    );
    return;
  }

    console.log(`✅ Sesiones conectadas cargadas desde CRM: ${sessions.join(', ')}`);
    console.log(`ℹ️ Iniciando solo sesiones ya vinculadas. Los QRs solo se generarán cuando el CRM lo solicite.`);

    // Iniciar solo sesiones que ya están conectadas (tienen tokens guardados)
    // Estas sesiones se reconectarán automáticamente sin generar QR
    sessions.forEach((sessionId, index) => {
      setTimeout(() => {
        startSession(sessionId);
      }, index * 2000); // 2 segundos entre cada sesión
    });
  } catch (err) {
    console.error('❌ Error al inicializar sesiones:', err.message);
  }
}

// Manejar cierre graceful
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recibido, cerrando sesiones...');
  Promise.all(
    Array.from(activeClients.values()).map(async (data) => {
      try {
        if (data.client) {
          await data.client.close();
        }
      } catch (err) {
        console.error('Error cerrando cliente:', err.message);
      }
    })
  ).then(() => {
    console.log('✅ Sesiones cerradas, saliendo...');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT recibido, cerrando sesiones...');
  Promise.all(
    Array.from(activeClients.values()).map(async (data) => {
      try {
        if (data.client) {
          await data.client.close();
        }
      } catch (err) {
        console.error('Error cerrando cliente:', err.message);
      }
    })
  ).then(() => {
    console.log('✅ Sesiones cerradas, saliendo...');
    process.exit(0);
  });
});

// Manejo de errores no capturados para evitar cierres inesperados
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado (uncaughtException):', err);
  console.error('Stack:', err.stack);
  // No cerrar el proceso, solo registrar el error
  // El servidor debe seguir funcionando
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada (unhandledRejection):', reason);
  console.error('Promise:', promise);
  // No cerrar el proceso, solo registrar el error
  // El servidor debe seguir funcionando
});

// Inicializar
bootstrap().catch((err) => {
  console.error('❌ Error al iniciar las sesiones de WPPConnect:', err.message);
});
