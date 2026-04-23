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
            try {
                // Preparar el payload similar al de handleMessages
                const fromMe = msg.key.fromMe;
                const remoteJid = msg.key.remoteJid;
                const text = msg.message?.conversation || 
                             msg.message?.extendedTextMessage?.text || 
                             msg.message?.imageMessage?.caption || 
                             msg.message?.videoMessage?.caption || "";

                if (!text && !msg.message) continue;

                const cleanNumber = remoteJid.split('@')[0].split(':')[0];

                const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        accountId,
                        companyId,
                        fromMe,
                        remoteJid,
                        cleanNumber,
                        text,
                        timestamp: msg.messageTimestamp,
                        messageId: msg.key.id,
                        isHistory: true // Flag para que el CRM sepa que es historial
                    })
                });

                if (response.ok) successCount++;
            } catch (err) {
                console.error(`[${accountId}] Error sincronizando mensaje individual del historial:`, err.message);
            }
        }

        console.log(`[${accountId}] ✅ Sincronización de historial completada: ${successCount}/${messages.length} mensajes procesados.`);
        return { success: true, total: messages.length, synced: successCount };

    } catch (error) {
        console.error(`[${accountId}] ❌ Error crítico recuperando historial:`, error.message);
        throw error;
    }
}
