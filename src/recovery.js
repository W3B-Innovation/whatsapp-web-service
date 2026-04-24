import fetch from 'node-fetch'

/**
 * Solicita el historial de mensajes al teléfono.
 * En Baileys v7, esta operación es asíncrona: los mensajes llegarán vía el evento 'messaging-history.set'
 * en whatsappService.js, el cual los reenviará al CRM.
 */
export async function fetchAndSyncHistory(sock, accountId, companyId, jid, count = 50) {
    if (!sock) throw new Error('Socket no disponible');

    console.log(`[${accountId}] 🕒 Iniciando solicitud de historial para ${jid} (cantidad: ${count})...`);

    try {
        // La firma correcta en Baileys v7 es: fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)
        // Si no tenemos el ID del último mensaje, usamos un objeto con id vacío.
        // Esto le indica a WhatsApp que queremos los últimos 'count' mensajes.
        
        const countNum = Number(count);
        
        // v7: El JID DEBE ser @s.whatsapp.net para fetchMessageHistory. 
        // Si es un LID, el servidor de WA no encontrará el historial.
        let targetJid = jid;
        if (jid.includes('@lid')) {
            const rawLid = jid.split('@')[0];
            const mapped = sessions[accountId]?.contactLids?.[rawLid];
            if (mapped) {
                targetJid = `${mapped}@s.whatsapp.net`;
                console.log(`[${accountId}] 🔄 Usando PN resuelto para historial: ${targetJid}`);
            } else {
                console.warn(`[${accountId}] ⚠️ Intentando recuperar historial de un LID no resuelto: ${jid}. Podría fallar.`);
            }
        }

        // Si no tenemos un mensaje de ancla, Baileys v7 a veces falla con {id: ''}.
        // Intentamos enviar una clave mínima pero válida si no se provee una.
        const anchorKey = { 
            remoteJid: targetJid, 
            fromMe: false, 
            id: 'SYNC_' + Date.now() // Un ID ficticio para forzar la petición si no hay mensajes
        };

        // El timestamp debe estar en segundos para Baileys v7
        const timestampSeconds = Math.floor(Date.now() / 1000);
        
        await sock.fetchMessageHistory(countNum, anchorKey, timestampSeconds);
        
        console.log(`[${accountId}] ✅ Solicitud de historial enviada para ${targetJid}. Cantidad: ${countNum}.`);

        return { 
            success: true, 
            requestedCount: countNum,
            total: countNum, // Cantidad solicitada
            synced: 0, // Aún no sabemos cuántos se sincronizarán realmente
            status: 'processing',
            message: `Solicitud de recuperación de ${countNum} mensajes enviada. Procesando asíncronamente...`
        };

    } catch (error) {
        console.error(`[${accountId}] ❌ Error al solicitar historial:`, error.message);
        
        // Fallback: Intentar sincronización general si la específica falla
        try {
            console.log(`[${accountId}] 🔄 Intentando fallback: Sincronización general de historial...`);
            await sock.fetchMessageHistory(Number(count), undefined, undefined);
            return { 
                success: true, 
                total: count, 
                synced: 0, 
                message: "Se inició una sincronización general para recuperar conversaciones." 
            };
        } catch (fallbackError) {
            throw new Error(`No se pudo iniciar la recuperación: ${fallbackError.message}`);
        }
    }
}
