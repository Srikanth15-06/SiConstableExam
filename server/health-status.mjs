export async function getHealthStatus({ databaseConfigured, checkDatabase }) {
    const configured = Boolean(databaseConfigured);
    let reachable = false;
    if (configured) {
        try {
            await checkDatabase();
            reachable = true;
        } catch {
            reachable = false;
        }
    }
    const ready = configured && reachable;
    return {
        statusCode: ready ? 200 : 503,
        body: {
            ok: ready,
            ready,
            service: 'TS Police AI Prep API',
            database: { provider: 'supabase', configured, reachable }
        }
    };
}