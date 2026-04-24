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
        
        // Intentar con la clave del chat
        await sock.fetchMessageHistory(countNum, { remoteJid: jid, fromMe: false, id: '' }, Date.now());
        
        console.log(`[${accountId}] ✅ Solicitud de historial enviada para ${jid}. Procesando asíncronamente.`);

        return { 
            success: true, 
            requestedCount: countNum,
            total: countNum, // Mantenemos por compatibilidad con el CRM actual
            synced: countNum, // Mantenemos por compatibilidad con el CRM actual
            status: 'started',
            message: `Solicitud de recuperación de ${countNum} mensajes enviada. Los mensajes se sincronizarán en segundo plano.`
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
