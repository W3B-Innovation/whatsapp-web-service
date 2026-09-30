const CRM_ORIGINS = (process.env.CRM_WEBHOOK_ORIGINS || 'https://crm.bitend.ai')
    .split(',').map(o => o.trim()).filter(Boolean);

if (process.env.CRM_WEBHOOK_URL) {
    try {
        CRM_ORIGINS.push(new URL(process.env.CRM_WEBHOOK_URL).origin);
    } catch {}
}

export function webhookHeaders(url) {
    const headers = { 'Content-Type': 'application/json' };
    const token = process.env.CRM_WEBHOOK_TOKEN || process.env.CRM_SYNC_TOKEN;
    if (!token || !url) return headers;
    try {
        const origin = new URL(url).origin;
        if (CRM_ORIGINS.includes(origin)) {
            headers.Authorization = `Bearer ${token}`;
        }
    } catch {}
    return headers;
}
