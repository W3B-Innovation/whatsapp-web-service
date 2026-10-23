// Orígenes del CRM a los que se envía el token. Se calcula en cada llamada (no al importar):
// en ES modules este archivo se evalúa antes del dotenv.config() de index.js.
function getCrmOrigins() {
    const origins = (process.env.CRM_WEBHOOK_ORIGINS || 'https://crm.bitend.ai,https://smart.w3binnovation.com')
        .split(',').map(o => o.trim()).filter(Boolean);

    if (process.env.CRM_WEBHOOK_URL) {
        try {
            origins.push(new URL(process.env.CRM_WEBHOOK_URL).origin);
        } catch {}
    }
    if (process.env.SMART_W3B_WEBHOOK_URL) {
        try {
            origins.push(new URL(process.env.SMART_W3B_WEBHOOK_URL).origin);
        } catch {}
    }
    return origins;
}

// Headers para llamadas a webhooks. El token solo se agrega si el destino es el CRM,
// para no filtrarlo a los otros sistemas que usan este microservicio.
export function webhookHeaders(url) {
    const headers = { 'Content-Type': 'application/json' };
    const token = process.env.CRM_WEBHOOK_TOKEN || process.env.CRM_SYNC_TOKEN;
    if (!token || !url) return headers;
    try {
        const origin = new URL(url).origin;
        if (getCrmOrigins().includes(origin)) {
            headers.Authorization = `Bearer ${token}`;
        }
    } catch {}
    return headers;
}
