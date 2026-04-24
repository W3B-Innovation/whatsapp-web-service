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

        // v7: Para obtener los mensajes más recientes sin error de 'remoteJid', 
        // debemos pasar un objeto que TENGA remoteJid pero con id vacío o nulo.
        const anchorKey = {
            remoteJid: targetJid,
            fromMe: false,
            id: '' // Cadena vacía indica "empezar desde el último mensaje recibido"
        };

        // El timestamp lo ponemos en 0 o lo omitimos para que no filtre por fecha inicial
        const timestampSeconds = 0;
        
        console.log(`[${accountId}] 📡 Enviando fetchMessageHistory (INITIAL) para ${targetJid}...`);
        
        // Fallback extra para LIDs: si el mapeo falló, intentar onWhatsApp justo antes del fetch
        if (jid.includes('@lid') && targetJid.includes('@lid')) {
            try {
                const onWa = await sock.onWhatsApp(jid);
                if (onWa && onWa[0]?.exists) {
                    targetJid = onWa[0].jid;
                    anchorKey.remoteJid = targetJid;
                    console.log(`[${accountId}] 🔄 LID Resuelto via onWhatsApp: ${jid} -> ${targetJid}`);
                }
            } catch (e) { }
        }

        await sock.fetchMessageHistory(countNum, anchorKey, timestampSeconds);
        
        console.log(`[${accountId}] ✅ Solicitud de historial enviada para ${targetJid}.`);

        return { 
            success: true, 
            message: `Solicitud de recuperación de ${countNum} mensajes enviada.`
        };

    } catch (error) {
        console.error(`[${accountId}] ❌ Error al solicitar historial para ${jid}:`, error.message);
        return { 
            success: false, 
            error: error.message 
        };
    }
}
