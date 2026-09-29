const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const apiUrl = (path) => `${API_BASE_URL}${path}`;

class AIServiceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AIServiceError';
    Object.assign(this, details);
  }
}

async function postAI(path, payload, provider) {
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    const message = import.meta.env.DEV
      ? `Network error calling ${path}: ${error.message}. Confirm the backend is running and the Vite proxy is reachable.`
      : `${provider} is temporarily unavailable. Please try again later.`;
    throw new AIServiceError(message, { provider, code: 'NETWORK_ERROR', path, cause: error });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const actualProvider = data.provider || provider;
    const reason = data.diagnostics?.reason;
    const message = import.meta.env.DEV
      ? `${actualProvider} request failed: HTTP ${response.status} ${path}. ${reason || data.message || response.statusText}${data.requestId ? ` Request ID: ${data.requestId}` : ''}`
      : data.message || `${provider} could not complete the request. Please try again later.`;
    throw new AIServiceError(message, {
      provider: actualProvider,
      code: data.code || 'HTTP_ERROR',
      requestId: data.requestId,
      status: response.status,
      path,
      diagnostics: data.diagnostics
    });
  }
  return data;
}

function validateContext({ exam, subject, topic, difficulty }) {
  if (![exam, subject, topic, difficulty].every((value) => typeof value === 'string' && value.trim())) {
    throw new AIServiceError('Select an exam, subject, topic, and difficulty before generating content.', { code: 'INVALID_REQUEST' });
  }
}

export async function generateQuestions({ exam, subject, topic, difficulty, level = difficulty, count = 10, attemptSeed, previousQuestionSignatures = [] }) {
  validateContext({ exam, subject, topic, difficulty: difficulty || level });
  const data = await postAI('/api/ai/questions', {
    exam,
    subject,
    topic,
    difficulty: difficulty || level,
    level: difficulty || level,
    count,
    attemptSeed,
    previousQuestionSignatures
  }, 'Gemini');

  if (!Array.isArray(data.questions) || data.questions.length !== 10) {
    throw new AIServiceError('Gemini did not return exactly ten validated questions.', { provider: 'Gemini', code: 'INVALID_RESPONSE' });
  }
  const mismatchedQuestion = data.questions.find((question) => question.subject !== subject || question.topic !== topic || (question.difficulty || question.level) !== (difficulty || level));
  if (mismatchedQuestion) {
    throw new AIServiceError('Gemini returned a question outside the selected subject, topic, or difficulty.', { provider: 'Gemini', code: 'CONTEXT_MISMATCH' });
  }
  return data.questions.map((question, index) => ({
    ...question,
    id: question.id || `ai_${attemptSeed}_${index}_${Date.now()}`,
    exam: Array.isArray(question.exam) ? question.exam : [exam],
    level: question.level || question.difficulty
  }));
}

export async function generateNotes({ exam, subject, topic, difficulty, level = difficulty }) {
  validateContext({ exam, subject, topic, difficulty: difficulty || level });
  const data = await postAI('/api/ai/notes', {
    exam,
    subject,
    topic,
    difficulty: difficulty || level,
    level: difficulty || level
  }, 'Groq');
  if (!data.notes || data.notes.exam !== exam || data.notes.subject !== subject || data.notes.topic !== topic) {
    throw new AIServiceError('Groq returned notes outside the selected exam, subject, or topic.', { provider: 'Groq', code: 'CONTEXT_MISMATCH' });
  }
  return data.notes;
}

export async function sendChatMessage({ exam, subject, topic, difficulty, messages, syllabus }) {
  validateContext({ exam, subject, topic, difficulty });
  const data = await postAI('/api/ai/chat', { exam, subject, topic, difficulty, level: difficulty, messages, syllabus }, 'OpenRouter');
  if (typeof data.reply !== 'string' || !data.reply.trim()) {
    throw new AIServiceError('OpenRouter returned an empty chat response.', { provider: 'OpenRouter', code: 'INVALID_RESPONSE' });
  }
  return data.reply;
}

export async function getAIStatus() {
  try {
    const response = await fetch(apiUrl('/api/ai/status'));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return data;
  } catch (error) {
    throw new AIServiceError(`Could not load AI status: ${error.message}`, { code: 'STATUS_ERROR' });
  }
}

function getDriveErrorMessage(code, fallback = 'Google Drive notes could not be loaded.') {
  const messages = {
    MISSING_GOOGLE_OAUTH_CONFIG: 'Google Drive OAuth is not configured on the server.',
    MISSING_DRIVE_TOKEN_ENCRYPTION_KEY: 'Google Drive token encryption is not configured on the server.',
    MISSING_ROOT_FOLDER: 'Google Drive root folder is not configured.',
    DRIVE_PERMISSION_DENIED: 'The connected Google account needs access to this folder; folder creation and uploads require Editor access.',
    DRIVE_QUOTA_EXCEEDED: 'Google Drive storage quota has been reached. Free up space in the Drive account or choose a Drive account with available storage before uploading files.',
    DRIVE_FOLDER_NOT_FOUND: 'The requested Google Drive folder was not found.',
    DRIVE_AUTH_FAILED: 'Google Drive authentication failed. Please reconnect your Google account.',
    DRIVE_TOKEN_STORAGE_FAILED: 'The saved Google Drive authorization could not be accessed.',
    DRIVE_API_FAILED: 'Google Drive is temporarily unavailable.'
  };
  return messages[code] || fallback;
}

export async function getDriveAuthUrl() {
  const response = await fetch(apiUrl('/api/drive/auth'), { credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.authUrl) {
    throw new AIServiceError(data.message || 'Google Drive authorization could not be started.', { provider: 'Google Drive', code: data.code || 'DRIVE_AUTH_FAILED', status: response.status });
  }
  return data.authUrl;
}

export async function checkDriveConnection() {
  const response = await fetch(apiUrl('/api/drive/auth/status'));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { connected: false, message: data.message || 'Google Drive is not connected.' };
  }
  return { connected: Boolean(data.connected || data.available), message: data.message || null };
}

export async function disconnectDrive() {
  const response = await fetch(apiUrl('/api/drive/logout'), { method: 'POST', credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new AIServiceError(data.message || 'Google Drive logout failed.', { provider: 'Google Drive', code: data.code || 'DRIVE_AUTH_FAILED', status: response.status });
  }
  return data;
}

export async function getDriveStatus() {
  let response;
  let data;
  try {
    response = await fetch(apiUrl('/api/drive/status'));
    data = await response.json().catch(() => ({}));
  } catch (error) {
    throw new AIServiceError(import.meta.env.DEV ? `Network error calling /api/drive/status: ${error.message}` : 'Google Drive is temporarily unavailable.', { provider: 'Google Drive', code: 'DRIVE_API_FAILED' });
  }
  if (!response.ok || !data.available || !data.rootFolderId) {
    throw new AIServiceError(data.message || getDriveErrorMessage(data.code, 'Google Drive is unavailable.'), {
      provider: 'Google Drive',
      code: data.code || 'DRIVE_API_FAILED',
      status: response.status,
      checks: data.checks,
      diagnostics: data.diagnostics
    });
  }
  return { rootFolderId: data.rootFolderId };
}

export async function getDriveFolder(folderId) {
  if (typeof folderId !== 'string' || !folderId.trim()) {
    throw new AIServiceError('A Google Drive folder ID is required.', { provider: 'Google Drive', code: 'INVALID_REQUEST' });
  }
  try {
    const response = await fetch(apiUrl(`/api/drive/folders/${encodeURIComponent(folderId)}`));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.folders) || !Array.isArray(data.files)) {
      const reason = getDriveErrorMessage(data.code, data.message);
      const message = import.meta.env.DEV
        ? `${reason} HTTP ${response.status}.${data.requestId ? ` Request ID: ${data.requestId}` : ''}`
        : reason;
      throw new AIServiceError(message, { provider: 'Google Drive', code: data.code, requestId: data.requestId, status: response.status });
    }
    return data;
  } catch (error) {
    if (error instanceof AIServiceError) throw error;
    throw new AIServiceError(import.meta.env.DEV ? `Network error calling /api/drive/folders: ${error.message}` : 'Google Drive notes could not be loaded.', { provider: 'Google Drive', code: 'DRIVE_API_FAILED' });
  }
}

export async function provisionDriveFolders(subjects) {
  try {
    const response = await fetch(apiUrl('/api/drive/folders/provision'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjects })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new AIServiceError(data.message || getDriveErrorMessage(data.code), {
        provider: 'Google Drive', code: data.code, requestId: data.requestId, status: response.status
      });
    }
    return data;
  } catch (error) {
    if (error instanceof AIServiceError) throw error;
    throw new AIServiceError(import.meta.env.DEV ? `Network error calling /api/drive/folders/provision: ${error.message}` : 'Google Drive folder setup failed.', { provider: 'Google Drive', code: 'DRIVE_API_FAILED' });
  }
}

export async function uploadDriveFile(folderId, subjectFolderId, file) {
  const mimeByExtension = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp'
  };
  const extension = file.name.split('.').at(-1)?.toLocaleLowerCase();
  const query = new URLSearchParams({
    parentFolderId: subjectFolderId,
    name: file.name,
    mimeType: file.type || mimeByExtension[extension] || 'application/octet-stream'
  });
  try {
    const response = await fetch(apiUrl(`/api/drive/folders/${encodeURIComponent(folderId)}/files?${query}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success || !data.file) {
      throw new AIServiceError(data.message || getDriveErrorMessage(data.code), {
        provider: 'Google Drive', code: data.code, requestId: data.requestId, status: response.status
      });
    }
    return data.file;
  } catch (error) {
    if (error instanceof AIServiceError) throw error;
    throw new AIServiceError(import.meta.env.DEV ? `Network error uploading to Google Drive: ${error.message}` : 'Google Drive upload failed.', { provider: 'Google Drive', code: 'DRIVE_API_FAILED' });
  }
}

export function getDriveFileContentUrl(topicFolderId, subjectFolderId, fileId, download = false) {
  const query = new URLSearchParams({ parentFolderId: subjectFolderId });
  if (download) query.set('download', '1');
  return apiUrl(`/api/drive/folders/${encodeURIComponent(topicFolderId)}/files/${encodeURIComponent(fileId)}/content?${query}`);
}