import fetch from 'node-fetch'
import { sessions } from './whatsappService.js'

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
            let mapped = sessions[accountId]?.contactLids?.[rawLid];
            
            // Si no está en caché, intentamos resolución nativa (Baileys v7)
            if (!mapped && sock.pnFromLIDUSync) {
                try {
                    console.log(`[${accountId}] 🔍 Resolviendo LID nativamente para historial: ${jid}`);
                    const results = await sock.pnFromLIDUSync([jid]);
                    if (results && results[jid]) {
                        mapped = results[jid].split('@')[0];
                        // Guardar en caché para futuras referencias
                        if (!sessions[accountId].contactLids) sessions[accountId].contactLids = {};
                        sessions[accountId].contactLids[rawLid] = mapped;
                        console.log(`[${accountId}] 🔗 LID Resuelto (Nativo): ${rawLid} -> ${mapped}`);
                    }
                } catch (e) {
                    console.error(`[${accountId}] Error en pnFromLIDUSync:`, e.message);
                }
            }

            if (mapped) {
                targetJid = `${mapped}@s.whatsapp.net`;
                console.log(`[${accountId}] 🔄 Usando PN resuelto para historial: ${targetJid}`);
            } else {
                console.warn(`[${accountId}] ⚠️ No se pudo resolver el LID ${jid}. La solicitud de historial probablemente fallará.`);
            }
        }

        // Si no tenemos un mensaje de ancla, Baileys v7 a veces falla con {id: ''}.
        // Generamos un ID que parezca real de WhatsApp (20 hex chars) para evitar rechazos
        const fakeId = [...Array(20)].map(() => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();
        
        const anchorKey = { 
            remoteJid: targetJid, 
            fromMe: false, 
            id: fakeId
        };

        // El timestamp debe estar en segundos para Baileys v7
        // Si pedimos historial, debemos usar un timestamp pasado (ej: 30 días) si queremos ver lo anterior.
        const timestampSeconds = Math.floor(Date.now() / 1000) - (60 * 60 * 24 * 30);
        
        console.log(`[${accountId}] 📡 Enviando fetchMessageHistory para ${targetJid}...`);
        console.log(`[${accountId}] 🔍 Parámetros: Count=${countNum}, AnchorID=${fakeId}, Since=${new Date(timestampSeconds * 1000).toISOString()}`);
        
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
