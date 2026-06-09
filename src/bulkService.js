import { sendMessage } from './whatsappService.js'
import fetch from 'node-fetch'

const MIN_DELAY = 25000;   // 25 segundos mínimo
const MAX_DELAY = 40000;  // 40 segundos máximo
const BATCH_SIZE = 15;    // Cada 15 mensajes se hace una pausa larga
const BATCH_PAUSE = 60000; // 1 minuto de pausa entre bloques

function getRandomDelay() {
    return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1) + MIN_DELAY);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Reporta el progreso de vuelta al CRM vía el webhook ya existente
 */
async function updateBulkProgress(webhookUrl, payload) {
    try {
        console.log(`[Bulk] Reporting progress to ${webhookUrl}: ${payload.sentCount} sent`);
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'bulk_progress',
                ...payload
            })
        });
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            console.error(`[Bulk] Webhook error (${response.status}): ${errBody}`);
        }
    } catch (e) {
        console.error('[Bulk] Error reporting progress:', e.message);
    }
}

export const activeCampaigns = new Map();

/**
 * Procesa el envío masivo en bucle con goteo (drip feeding)
 */
export async function processBulkSend(data) {
    const { accountId, companyId, message, contacts, bulkMessageId, customTemplate, webhookUrl } = data;
    
    console.log(`[Bulk] 🚀 Iniciando campaña ${bulkMessageId} para ${contacts.length} contactos en la sesión ${accountId}`);

    // Registrar campaña activa
    activeCampaigns.set(bulkMessageId, { status: 'sending', paused: false, cancelled: false });

    let sentCount = 0;
    let failedCount = 0;
    const results = [];

    for (let i = 0; i < contacts.length; i++) {
        // Verificar si la campaña fue cancelada o pausada
        const campaignState = activeCampaigns.get(bulkMessageId);
        if (campaignState && (campaignState.paused || campaignState.cancelled)) {
            const finalStatus = campaignState.paused ? 'paused' : 'cancelled';
            console.log(`[Bulk] Campaña ${bulkMessageId} interrumpida en microservicio. Estado: ${finalStatus}`);
            
            await updateBulkProgress(webhookUrl, {
                bulkMessageId,
                sentCount,
                failedCount,
                results: results.slice(-10),
                status: finalStatus
            });
            
            activeCampaigns.delete(bulkMessageId);
            return;
        }

        const contact = contacts[i];
        
        // Procesar mensaje (reemplazar variables)
        const name = contact.name || 'Cliente';
        const personalizedMessage = message.replace(/\{\{nombre\}\}/gi, name)
                                           .replace(/\{\{name\}\}/gi, name);
        
        const cleanNumber = contact.phoneNumber.replace(/\D/g, '');

        try {
            const media = customTemplate?.media;
            const result = await sendMessage(accountId, cleanNumber, personalizedMessage, media);
            
            sentCount++;
            results.push({ 
                phoneNumber: contact.phoneNumber, 
                status: 'sent', 
                messageId: result?.key?.id 
            });
            
            console.log(`[Bulk] [${i+1}/${contacts.length}] Mensaje enviado a ${cleanNumber}`);

            // Reportar al webhook individualmente para que se cree el registro en business_messages / business_conversations
            if (webhookUrl && result?.key?.id) {
                const messagePayload = {
                    accountId,
                    companyId: companyId || null,
                    fromMe: true,
                    remoteJid: `${cleanNumber}@s.whatsapp.net`,
                    text: personalizedMessage,
                    timestamp: Math.floor(Date.now() / 1000),
                    messageId: result.key.id,
                    bulkMessageId,
                    media: media ? {
                        url: media.url,
                        type: media.type || 'image'
                    } : null
                };

                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(messagePayload)
                }).then(res => {
                    if (!res.ok) {
                        console.error(`[Bulk Webhook Message] Error notifying message sent to ${cleanNumber} (${res.status})`);
                    } else {
                        console.log(`[Bulk Webhook Message] ✅ Notified CRM for message to ${cleanNumber}`);
                    }
                }).catch(err => {
                    console.error(`[Bulk Webhook Message] Error notifying message sent to ${cleanNumber}:`, err.message);
                });
            }

        } catch (error) {
            console.error(`[Bulk] [${i+1}/${contacts.length}] ❌ Error para ${contact.phoneNumber}:`, error.message);
            failedCount++;
            results.push({ 
                phoneNumber: contact.phoneNumber, 
                status: 'failed', 
                error: error.message 
            });
        }

        // Reportar progreso en cada mensaje
        if (true) {
            const isLast = i === contacts.length - 1;
            await updateBulkProgress(webhookUrl, {
                bulkMessageId,
                sentCount,
                failedCount,
                results: results.slice(-10), // Mandar solo los últimos 10 para no saturar el payload
                status: isLast ? (failedCount === contacts.length ? 'failed' : 'completed') : 'sending'
            });
        }

        // Lógica de espera entre mensajes (Goteo)
        if (i < contacts.length - 1) {
            const isEndOfBatch = (i + 1) % BATCH_SIZE === 0;
            const waitTime = isEndOfBatch ? BATCH_PAUSE : getRandomDelay();
            
            if (isEndOfBatch) {
                console.log(`[Bulk] ⏳ Pausa de bloque (${BATCH_PAUSE/1000}s) tras ${i + 1} mensajes...`);
            }
            
            await delay(waitTime);
        }
    }

    activeCampaigns.delete(bulkMessageId);
    console.log(`[Bulk] ✅ Campaña ${bulkMessageId} finalizada: ${sentCount} OK, ${failedCount} ERR`);
}
