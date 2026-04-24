import fetch from 'node-fetch'

/**
 * Recupera el historial de mensajes de un chat específico y lo envía al CRM.
 */
export async function fetchAndSyncHistory(sock, accountId, companyId, jid, count = 50) {
    if (!sock) throw new Error('Socket no disponible');

    console.log(`[${accountId}] 🕒 Solicitando historial para ${jid} (cantidad: ${count})...`);

    try {
        // fetchMessageHistory devuelve una promesa con el array de mensajes
        const messages = await sock.fetchMessageHistory(jid, count, undefined);
        
        if (!messages || messages.length === 0) {
            console.log(`[${accountId}] ℹ️ No se encontró historial para ${jid} en el dispositivo.`);
            return { success: true, count: 0 };
        }

        console.log(`[${accountId}] 📥 Historial recibido: ${messages.length} mensajes. Sincronizando con CRM...`);

        const webhookUrl = process.env.CRM_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-sync/webhook';
        
        let successCount = 0;
        for (const msg of messages) {
            const msgId = msg.key.id;
            try {
                // Preparar el payload compatible con el webhook (formato Baileys)
                const fromMe = !!msg.key.fromMe;
                const remoteJid = msg.key.remoteJid;
                const text = msg.message?.conversation || 
                             msg.message?.extendedTextMessage?.text || 
                             msg.message?.imageMessage?.caption || 
                             msg.message?.videoMessage?.caption || "";

                if (!text && !msg.message) continue;

                const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.CRM_SYNC_TOKEN}`
                    },
                    body: JSON.stringify({
                        accountId,
                        session: accountId, // EL WEBHOOK NECESITA ESTO PARA EL FORMATO BAILEYS
                        companyId,
                        event: 'on_message',
                        message: {
                            id: msgId,
                            from: remoteJid,
                            to: fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : undefined,
                            body: text,
                            text: text,
                            timestamp: msg.messageTimestamp,
                            fromMe: fromMe,
                            type: msg.message?.imageMessage ? 'image' : (msg.message?.videoMessage ? 'video' : 'chat'),
                            isHistory: true
                        }
                    })
                });

                if (response.ok) {
                    successCount++;
                } else {
                    const errBody = await response.text().catch(() => 'No error body');
                    console.error(`[${accountId}] Error en webhook (${response.status}): ${errBody}`);
                }
            } catch (err) {
                console.error(`[${accountId}] Error sincronizando mensaje ${msgId}:`, err.message);
            }
        }

        console.log(`[${accountId}] ✅ Sincronización de historial completada: ${successCount}/${messages.length} mensajes procesados.`);
        return { success: true, total: messages.length, synced: successCount };

    } catch (error) {
        console.error(`[${accountId}] ❌ Error crítico recuperando historial:`, error.message);
        throw error;
    }
}
