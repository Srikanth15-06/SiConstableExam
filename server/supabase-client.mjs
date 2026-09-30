import { createClient } from '@supabase/supabase-js';

let client;

export function getSupabaseConfigurationStatus() {
    return {
        urlConfigured: Boolean(String(process.env.SUPABASE_URL || '').trim()),
        serviceRoleKeyConfigured: Boolean(String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()),
        anonKeyConfigured: Boolean(String(process.env.SUPABASE_ANON_KEY || '').trim())
    };
}

export function isSupabaseConfigured() {
    const status = getSupabaseConfigurationStatus();
    return status.urlConfigured && status.serviceRoleKeyConfigured;
}

export function getSupabaseClient() {
    if (!isSupabaseConfigured()) {
        const error = new Error('Supabase server configuration is missing.');
        error.code = 'SUPABASE_NOT_CONFIGURED';
        throw error;
    }
    if (!client) {
        client = createClient(
            String(process.env.SUPABASE_URL).trim(),
            String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim(),
            {
                auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
                global: { fetch: (...args) => globalThis.fetch(...args) }
            }
        );
    }
    return client;
}

export async function checkSupabaseConnection(supabase = getSupabaseClient()) {
    const { error } = await supabase.from('app_users').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) {
        const failure = new Error('Supabase database is unreachable.');
        failure.code = 'SUPABASE_UNAVAILABLE';
        throw failure;
    }
    return true;
}