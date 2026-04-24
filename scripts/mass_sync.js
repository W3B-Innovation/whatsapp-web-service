import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuración
const MICROSERVICE_URL = 'https://wb.bitend.ai'; // Cambia esto si el servicio está en otro puerto o dominio
const ACCOUNT_ID = 'VJxvPDx2uAgLfKiKwoSW-custom-1776276193580'; // La cuenta que vimos en los logs
const MARKDOWN_FILE = 'C:/Users/Oscar/.gemini/antigravity/brain/e40644f5-0bca-44b2-aadc-6a051dfc7575/registro_recuperacion_parcial.md.resolved';

async function runMassSync() {
    console.log('🚀 Iniciando Sincronización Masiva de Historial...');

    if (!fs.existsSync(MARKDOWN_FILE)) {
        console.error(`❌ No se encontró el archivo: ${MARKDOWN_FILE}`);
        return;
    }

    const content = fs.readFileSync(MARKDOWN_FILE, 'utf-8');
    const lines = content.split('\n');

    // Extraer JIDs únicos de la tabla markdown
    const jids = new Set();
    lines.forEach(line => {
        // Buscar patrones que parezcan números o LIDs en la segunda columna
        const match = line.match(/\|\s*[^|]+\s*\|\s*(\d+)\s*\|/);
        if (match) {
            const id = match[1];
            // Si tiene 13 o menos dígitos, suele ser PN. Si tiene más, es LID.
            const jid = id.length > 13 ? `${id}@lid` : `${id}@s.whatsapp.net`;
            jids.add(jid);
        }
    });




    console.log(`[INFO] Se encontraron ${jids.size} contactos únicos para sincronizar.`);

    let count = 0;
    const total = jids.size;

    for (const jid of jids) {
        count++;
        try {
            console.log(`[${count}/${total}] [SYNC] Solicitando historial para: ${jid}...`);
            const response = await axios.post(`${MICROSERVICE_URL}/fetch-history`, {
                accountId: ACCOUNT_ID,
                number: jid,
                count: 50
            });

            if (response.data.success) {
                console.log(`✅ OK: ${jid}`);
            } else {
                console.warn(`⚠️ Error parcial para ${jid}:`, response.data);
            }

            // Aumentamos el retraso a 5 segundos para no saturar el socket de WhatsApp
            // Esto es crucial para que no nos marquen como spam o ignoren las peticiones
            await new Promise(r => setTimeout(r, 5000));

        } catch (error) {
            console.error(`❌ Falló ${jid}:`, error.response?.data || error.message);
        }
    }

    console.log('\n✨ Sincronización masiva finalizada. Espera unos minutos para ver los resultados en el CRM.');
}

runMassSync();
