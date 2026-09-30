export const REQUIRED_DRIVE_ROOT_FOLDER_ID = '1rz_XI2AkAkQNfrsbKW9Rs78xSptWFJ1z';

export function validateProductionEnvironment(environment = process.env) {
    const renderEnvironment = environment.RENDER === 'true' || Boolean(environment.RENDER_SERVICE_ID);
    const production = environment.NODE_ENV === 'production';
    const issues = [];

    if (renderEnvironment && !production) issues.push('NODE_ENV must be production on Render');
    if (!production) return issues;

    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'FRONTEND_URL']) {
        if (!String(environment[name] || '').trim()) issues.push(`${name} is required`);
    }
    if (String(environment.SESSION_SECRET || '').trim().length < 32) {
        issues.push('SESSION_SECRET must contain at least 32 characters');
    }

    try {
        const frontend = new URL(environment.FRONTEND_URL || '');
        const supabase = new URL(environment.SUPABASE_URL || '');
        if (frontend.protocol !== 'https:' || supabase.protocol !== 'https:') {
            issues.push('FRONTEND_URL and SUPABASE_URL must use HTTPS');
        }
    } catch {
        issues.push('FRONTEND_URL or SUPABASE_URL is not a valid URL');
    }

    const rootFolderId = String(environment.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim();
    if (rootFolderId && rootFolderId !== REQUIRED_DRIVE_ROOT_FOLDER_ID) {
        issues.push('GOOGLE_DRIVE_ROOT_FOLDER_ID must remain the existing Notes Library root');
    }

    const hasPartialGoogleOAuth = Boolean(
        environment.GOOGLE_CLIENT_ID || environment.GOOGLE_CLIENT_SECRET || environment.GOOGLE_REDIRECT_URI
    );
    if (hasPartialGoogleOAuth && environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET && environment.GOOGLE_REDIRECT_URI) {
        try {
            const frontend = new URL(environment.FRONTEND_URL || '');
            const redirect = new URL(environment.GOOGLE_REDIRECT_URI);
            if (redirect.protocol !== 'https:' || redirect.origin !== frontend.origin || redirect.pathname !== '/api/drive/oauth2callback') {
                issues.push('GOOGLE_REDIRECT_URI must use the HTTPS frontend origin and /api/drive/oauth2callback path');
            }
        } catch {
            issues.push('GOOGLE_REDIRECT_URI is not a valid URL');
        }
    }

    return [...new Set(issues)];
}