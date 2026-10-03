const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const apiUrl = (path) => `${API_BASE_URL}${path}`;

class AIServiceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AIServiceError';
    Object.assign(this, details);
  }
}

async function requestCandidateApi(path, { method = 'GET', body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      credentials: 'include',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch {
    throw new AIServiceError('Unable to connect to the server. Please try again.', { code: 'NETWORK_ERROR' });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = response.status >= 500
      ? 'Your saved data is temporarily unavailable. Nothing was cleared. Please retry.'
      : data.message || 'The request could not be completed. Check your details and try again.';
    throw new AIServiceError(message, { code: data.code || 'REQUEST_FAILED', status: response.status });
  }
  return data;
}

export async function signUpCandidate({ name, email, password }) {
  return requestCandidateApi('/api/auth/signup', { method: 'POST', body: { name, email, password } });
}

export async function loginCandidate({ email, password }) {
  return requestCandidateApi('/api/auth/login', { method: 'POST', body: { email, password } });
}

export async function importLegacyCandidate({ legacyRecord, password }) {
  return requestCandidateApi('/api/auth/legacy-import', {
    method: 'POST',
    body: { legacyRecord, password }
  });
}

export async function logoutCandidate() {
  return requestCandidateApi('/api/auth/logout', { method: 'POST', body: {} });
}

export async function getCurrentCandidate() {
  return requestCandidateApi('/api/auth/me');
}

export async function getCurrentCandidateData() {
  return requestCandidateApi('/api/me/data');
}

export async function updateCurrentCandidateProfile(profile) {
  return requestCandidateApi('/api/me/profile', { method: 'PATCH', body: profile });
}

export async function saveCurrentCandidatePlanner(plannerData, expectedRevision = 0) {
  return requestCandidateApi('/api/me/planner', { method: 'PUT', body: { plannerData, expectedRevision } });
}

export async function saveCurrentCandidateBookmarks(savedQuestions) {
  return requestCandidateApi('/api/me/bookmarks', { method: 'PUT', body: { savedQuestions } });
}

export async function createTestAttempt({ exam, subject, topic, difficulty }) {
  const idempotencyKey = crypto.randomUUID();
  return requestCandidateApi('/api/tests', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { exam, subject, topic, difficulty }
  });
}

export async function createBookmarkedTestAttempt({ questionIds, durationMinutes }) {
  return requestCandidateApi('/api/tests/bookmarked', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { questionIds, durationMinutes }
  });
}

export async function createRevisionMockAttempt({ exam, questionCount, durationMinutes, mode = 'revision-mock' }) {
  return requestCandidateApi('/api/tests/mock', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { exam, questionCount, durationMinutes, mode }
  });
}

export async function submitTestAttempt(attemptId, answers) {
  return requestCandidateApi(`/api/tests/${encodeURIComponent(attemptId)}/submit`, {
    method: 'POST',
    body: { answers }
  });
}

export async function saveTestAnswers(attemptId, answers) {
  return requestCandidateApi(`/api/tests/${encodeURIComponent(attemptId)}/answers`, {
    method: 'PUT',
    body: { answers }
  });
}

export async function getTopicLearningVideos(subject, topic) {
  const query = new URLSearchParams({ subject, topic });
  return requestCandidateApi(`/api/learning-videos?${query.toString()}`);
}

export async function getAdminLearningVideos(exam, subject, topic) {
  const query = new URLSearchParams({ exam, subject, topic });
  return requestCandidateApi(`/api/admin/learning-videos?${query.toString()}`);
}

export async function createAdminLearningVideo(video) {
  return requestCandidateApi('/api/admin/learning-videos', { method: 'POST', body: video });
}

export async function updateAdminLearningVideo(id, video) {
  return requestCandidateApi(`/api/admin/learning-videos/${encodeURIComponent(id)}`, { method: 'PATCH', body: video });
}

export async function deleteAdminLearningVideo(id) {
  return requestCandidateApi(`/api/admin/learning-videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function postAI(path, payload, provider) {
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      credentials: 'include',
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
    DRIVE_TOKEN_STORAGE_NOT_CONFIGURED: 'Google Drive needs Supabase token storage and its encryption key configured on the server before it can connect.',
    SUBJECT_FOLDER_NOT_FOUND: 'No subject folder found in the configured Notes Library.',
    TOPIC_FOLDER_NOT_FOUND: 'No notes folder found for this topic.',
    MISSING_ROOT_FOLDER: 'Google Drive root folder is not configured.',
    DRIVE_PERMISSION_DENIED: 'The connected Google account needs access to this folder; folder creation and uploads require Editor access.',
    DRIVE_QUOTA_EXCEEDED: 'Google Drive storage quota has been reached. Free up space in the Drive account or choose a Drive account with available storage before uploading files.',
    FOLDER_ACCESS_FAILED: 'The connected Google account cannot access the configured Notes Library folder.',
    DRIVE_FOLDER_NOT_FOUND: 'The requested Google Drive folder was not found.',
    DRIVE_FILE_NOT_FOUND: 'The requested Google Drive file was not found in the Notes Library.',
    DRIVE_API_NOT_ENABLED: 'Google Drive API is not enabled for the configured Google Cloud project.',
    DRIVE_RATE_LIMITED: 'Google Drive is receiving too many requests. Wait briefly and try again.',
    DRIVE_AUTH_REVOKED: 'The shared Notes Library is currently unavailable.',
    AUTH_REQUIRED: 'The shared Notes Library is currently unavailable.',
    GOOGLE_REDIRECT_URI_MISMATCH: 'Google OAuth callback configuration does not match Google Cloud.',
    GOOGLE_INVALID_CLIENT: 'Google OAuth credentials are invalid on the server.',
    GOOGLE_UNAUTHORIZED_CLIENT: 'The Google OAuth client is not authorized for this application.',
    DRIVE_AUTH_FAILED: 'The shared Notes Library is currently unavailable.',
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

export async function loginDriveAdmin(key) {
  const response = await fetch(apiUrl('/api/drive/admin/session'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new AIServiceError(data.message || 'Administrator access could not be verified.', {
      provider: 'Google Drive', code: data.code || 'DRIVE_ADMIN_AUTH_INVALID', status: response.status
    });
  }
  return data;
}

export async function logoutDriveAdmin() {
  const response = await fetch(apiUrl('/api/drive/admin/session'), {
    method: 'DELETE',
    credentials: 'include'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new AIServiceError(data.message || 'Administrator session could not be closed.', {
      provider: 'Google Drive', code: data.code || 'DRIVE_API_FAILED', status: response.status
    });
  }
  return data;
}

export async function checkDriveConnection() {
  const response = await fetch(apiUrl('/api/drive/auth/status'), { credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ...data, connected: false, available: false };
  }
  return {
    ...data,
    connected: Boolean(data.connected || data.authenticated),
    available: Boolean(data.available),
    message: data.message || null
  };
}

export async function disconnectDrive() {
  const response = await fetch(apiUrl('/api/drive/disconnect'), { method: 'POST', credentials: 'include' });
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
    response = await fetch(apiUrl('/api/drive/status'), { credentials: 'include' });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    throw new AIServiceError(import.meta.env.DEV ? `Network error calling /api/drive/status: ${error.message}` : 'Google Drive is temporarily unavailable.', { provider: 'Google Drive', code: 'DRIVE_API_FAILED' });
  }
  if (!response.ok || !data.available || !data.rootFolderId) {
    const authUnavailable = ['AUTH_REQUIRED', 'DRIVE_AUTH_FAILED', 'DRIVE_AUTH_REVOKED'].includes(data.code);
    const message = authUnavailable ? getDriveErrorMessage(data.code) : data.message || getDriveErrorMessage(data.code, 'Google Drive is unavailable.');
    throw new AIServiceError(message, {
      provider: 'Google Drive',
      code: data.code || 'DRIVE_API_FAILED',
      status: response.status,
      checks: data.checks,
      diagnostics: data.diagnostics
    });
  }
  return data;
}

export async function getDriveFolder(folderId) {
  if (typeof folderId !== 'string' || !folderId.trim()) {
    throw new AIServiceError('A Google Drive folder ID is required.', { provider: 'Google Drive', code: 'INVALID_REQUEST' });
  }
  try {
    const response = await fetch(apiUrl(`/api/drive/folders/${encodeURIComponent(folderId)}`), { credentials: 'include' });
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

export async function getDriveTopicFiles({ exam, subject, topic }) {
  if (![exam, subject, topic].every((value) => typeof value === 'string' && value.trim())) {
    throw new AIServiceError('Choose an exam, subject, and topic to view Google Drive notes.', { provider: 'Google Drive', code: 'INVALID_REQUEST' });
  }
  const query = new URLSearchParams({ exam, subject, topic });
  try {
    const response = await fetch(apiUrl(`/api/drive/files?${query}`), { credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true || !Array.isArray(data.files)) {
      throw new AIServiceError(data.message || getDriveErrorMessage(data.code), {
        provider: 'Google Drive', code: data.code || 'DRIVE_API_FAILED', requestId: data.requestId, status: response.status
      });
    }
    return data;
  } catch (error) {
    if (error instanceof AIServiceError) throw error;
    throw new AIServiceError(import.meta.env.DEV ? `Network error loading topic notes: ${error.message}` : 'Google Drive notes could not be loaded.', {
      provider: 'Google Drive', code: 'DRIVE_API_FAILED'
    });
  }
}

export async function provisionDriveFolders(subjects) {
  try {
    const response = await fetch(apiUrl('/api/drive/folders/provision'), {
      method: 'POST',
      credentials: 'include',
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
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp'
  };
  const extension = file.name.split('.').at(-1)?.toLocaleLowerCase();
  const query = new URLSearchParams({
    folderId,
    parentFolderId: subjectFolderId,
    name: file.name,
    mimeType: file.type || mimeByExtension[extension] || 'application/octet-stream'
  });
  try {
    const response = await fetch(apiUrl(`/api/drive/candidate/folders/${encodeURIComponent(folderId)}/files?${query}`), {
      method: 'POST',
      credentials: 'include',
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

export async function deleteDriveFile(fileId, folderId) {
  const query = new URLSearchParams({ folderId });
  const response = await fetch(apiUrl(`/api/drive/files/${encodeURIComponent(fileId)}?${query}`), {
    method: 'DELETE',
    credentials: 'include'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new AIServiceError(data.message || getDriveErrorMessage(data.code), {
      provider: 'Google Drive', code: data.code || 'DRIVE_API_FAILED', requestId: data.requestId, status: response.status
    });
  }
  return data;
}

export function getDriveFileContentUrl(topicFolderId, subjectFolderId, fileId, download = false) {
  const query = new URLSearchParams({ folderId: topicFolderId, parentFolderId: subjectFolderId });
  if (download) query.set('download', '1');
  return apiUrl(`/api/drive/files/${encodeURIComponent(fileId)}?${query}`);
}