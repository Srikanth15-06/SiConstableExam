import React, { useState, useEffect, useMemo, useEffectEvent, useRef } from 'react';
import YouTubeVideoPlayer from './YouTubeVideoPlayer.jsx';
import {
  BookOpen, Folder, Download, FileText, Target, Clock, ChevronRight, BarChart2, User, Sparkles,
  ArrowLeft, Send, ShieldAlert, Play, X, Maximize2, Minimize2, Brain, Lock, Unlock, RotateCcw, Code, LogOut, Mail, KeyRound, UserPlus, RefreshCw,
  Volume2, VolumeX, CalendarDays, Pencil, Trash2
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell
} from 'recharts';
import { generateNotes, sendChatMessage, getDriveStatus, getDriveFolder, getDriveTopicFiles, getDriveAuthUrl, loginDriveAdmin, logoutDriveAdmin, checkDriveConnection, uploadDriveFile, getDriveFileContentUrl, signUpCandidate, loginCandidate, importLegacyCandidate, logoutCandidate, getCurrentCandidate, getCurrentCandidateData, updateCurrentCandidateProfile, saveCurrentCandidatePlanner, saveCurrentCandidateBookmarks, createTestAttempt, createBookmarkedTestAttempt, createRevisionMockAttempt, submitTestAttempt, saveTestAnswers, getTopicLearningVideos, getAdminLearningVideos, createAdminLearningVideo, updateAdminLearningVideo, deleteAdminLearningVideo } from './services/aiService.js';
import { normalizeAnswer } from './test-results.js';
import { LEGACY_MEMBERS_STORAGE_KEY, readLegacyMembers, removeImportedLegacyMember } from './legacy-import.js';
import { SUBJECT_TOPICS } from './syllabus.js';
import {
  calculateSubjectCompletion,
  getExamHistory,
  getTopicProgress,
  normalizeUserProgress,
  getPriorityColorClass,
  getProgressColorClass,
  getStatusColorClass,
  mergePlannerSnapshot,
  resolveTopicWeightage,
  daysRemainingForExam
} from './planner-utils.js';
import { buildAiSchedulePrompt, buildAiStudySchedule, parseAiScheduleResponse } from './ai-study-schedule.js';
import { createProgressCsv, getMistakeNotebook, getMockTestInsights, getSpacedRevisionRecommendations } from './profile-tools.js';

const getTopicWeightage = (exam, subject, topic) => {
  const weightage = resolveTopicWeightage(exam, subject, topic, {});
  const isHighWeightage = weightage >= 4;
  return {
    range: isHighWeightage ? '2-3 questions' : '1-2 questions',
    priority: isHighWeightage ? 'High focus' : 'Regular focus'
  };
};

const getProgressStatus = (value = 0) => {
  const score = Number(value) || 0;
  if (score >= 75) return 'Strong';
  if (score >= 60) return 'Needs improvement';
  if (score >= 35) return 'Weak';
  if (score > 0) return 'Critical';
  return 'Not started';
};

const TOTAL_TOPICS = Object.values(SUBJECT_TOPICS).reduce((total, topics) => total + topics.length, 0);
const UPCOMING_EXAMS = [
  { id: 'si', name: 'TS SI / SI-equivalent', date: '29 November 2026', weekday: 'Sunday', targetTime: Date.parse('2026-11-29T00:00:00+05:30') },
  { id: 'constable', name: 'TS Constable / PC-equivalent', date: '20 December 2026', weekday: 'Sunday', targetTime: Date.parse('2026-12-20T00:00:00+05:30') }
];
const isDriveBrowserPreviewable = (mimeType) => mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType.startsWith('image/');
const fileMimeLabel = (mimeType) => mimeType.startsWith('application/vnd.google-apps.') ? 'Google file · PDF preview' : mimeType;

function getDriveQueryState() {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  if (params.get('drive') === 'connected') {
    window.history.replaceState({}, '', window.location.pathname);
    return {
      connected: true,
      notesError: '',
      provisionMessage: 'Google Drive connected successfully.',
      connectionStatus: 'connected',
      diagnostics: { connected: true, available: true }
    };
  }

  if (params.get('drive_error') || params.get('drive') === 'error') {
    const code = params.get('drive_code') || params.get('drive_error');
    const errors = {
      authorization_state_invalid: 'Google Drive authorization could not be verified. Start the connection again.',
      authorization_cancelled: 'Google Drive authorization was cancelled.',
      connection_failed: 'Google Drive connection failed. Check the OAuth configuration and try again.',
      DRIVE_TOKEN_STORAGE_NOT_CONFIGURED: 'Google Drive is not ready yet. Configure Supabase and the Drive token encryption key on the backend.',
      GOOGLE_REDIRECT_URI_MISMATCH: 'Google Drive callback configuration does not match Google Cloud.',
      AUTH_REQUIRED: 'Google Drive authorization is required. Connect your Google account.',
      DRIVE_AUTH_REVOKED: 'Google Drive access was revoked. Connect your Google account again.'
    };

    window.history.replaceState({}, '', window.location.pathname);
    return {
      connected: false,
      notesError: errors[code] || 'Google Drive connection failed.',
      provisionMessage: '',
      connectionStatus: 'error',
      diagnostics: { code, connected: false, available: false }
    };
  }

  return null;
}

const getExamCountdown = (targetTime, now) => {
  const remainingMinutes = Math.max(0, Math.floor((targetTime - now) / 60_000));
  return {
    days: Math.floor(remainingMinutes / 1440),
    hours: Math.floor((remainingMinutes % 1440) / 60),
    minutes: remainingMinutes % 60,
    isPast: targetTime <= now
  };
};

const getLocalDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function initializeExamAudio(contextRef) {
  if (typeof window === 'undefined') return;
  try {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return;
    if (!contextRef.current || contextRef.current.state === 'closed') contextRef.current = new AudioContextConstructor();
    void contextRef.current.resume().catch(() => undefined);
  } catch {
    contextRef.current = null;
  }
}

function playExamTone(context, { frequency = 760, duration = 0.2, type = 'sine', volume = 0.12 } = {}) {
  if (!context || context.state !== 'running') return;
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
    gain.gain.setValueAtTime(volume, start + Math.max(0.03, duration - 0.08));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration);
  } catch {
    // Audio is optional and must never interrupt an exam.
  }
}

function playExamBuzzer(context) {
  playExamTone(context, { frequency: 220, duration: 3, type: 'sawtooth', volume: 0.1 });
}

const normalizeExamForRequest = (exam) => {
  if (exam === 'SI') return 'TS SI';
  if (exam === 'CONSTABLE') return 'TS Constable';
  return exam;
};

const createEmptyPlannerState = (member = null) => ({
  examType: member?.exam || 'SI',
  generatedAt: null,
  summary: {},
  topicMetrics: [],
  schedule: [],
  aiScheduleDailyMinutes: 180
});

const DIFFICULTY_LEVELS = ["Beginner", "Intermediate", "Expert", "Pro"];
const LEARNING_STAGES = [
  { name: 'Beginner', detail: 'Fundamentals and definitions', color: 'bg-emerald-400' },
  { name: 'Basic', detail: 'Simple applications', color: 'bg-sky-400' },
  { name: 'Intermediate', detail: 'Patterns and practice', color: 'bg-amber-400' },
  { name: 'Advanced', detail: 'Complex applications', color: 'bg-orange-400' },
  { name: 'Expert', detail: 'Tricky exam concepts', color: 'bg-rose-400' },
  { name: 'Exam Ready', detail: 'Revision and strategy', color: 'bg-teal-400' }
];
const NOTE_SECTION_PRESENTATION = [
  { key: 'concepts', title: 'Core Concepts', stage: 'Start Here', icon: BookOpen, tone: 'teal' },
  { key: 'rules', title: 'Rules', stage: 'Build Your Foundation', icon: Target, tone: 'sky' },
  { key: 'formulas', title: 'Rules & Formulas', stage: 'Build Your Foundation', icon: Target, tone: 'blue' },
  { key: 'examples', title: 'Worked Examples', stage: 'Practice Concepts', icon: Play, tone: 'cyan' },
  { key: 'shortcuts', title: 'Shortcuts', stage: 'Go Advanced', icon: Sparkles, tone: 'amber' },
  { key: 'commonMistakes', title: 'Common Mistakes', stage: 'Master the Topic', icon: X, tone: 'rose' },
  { key: 'examTips', title: 'Exam Strategy', stage: 'Exam Ready', icon: Target, tone: 'emerald' },
  { key: 'quickRevision', title: 'Quick Revision', stage: 'Exam Ready', icon: RotateCcw, tone: 'indigo' }
];
const LEARNING_LEVEL_INDEX = { Beginner: 0, Basic: 1, Intermediate: 2, Advanced: 3, Expert: 4, Pro: 5 };
const NOTE_TONE_CLASSES = {
  teal: { icon: 'text-teal-300', border: 'border-teal-500/25', label: 'text-teal-200' },
  sky: { icon: 'text-sky-300', border: 'border-sky-500/25', label: 'text-sky-200' },
  blue: { icon: 'text-blue-300', border: 'border-blue-500/25', label: 'text-blue-200' },
  cyan: { icon: 'text-cyan-300', border: 'border-cyan-500/25', label: 'text-cyan-200' },
  amber: { icon: 'text-amber-300', border: 'border-amber-500/25', label: 'text-amber-200' },
  rose: { icon: 'text-rose-300', border: 'border-rose-500/25', label: 'text-rose-200' },
  emerald: { icon: 'text-emerald-300', border: 'border-emerald-500/25', label: 'text-emerald-200' },
  indigo: { icon: 'text-indigo-300', border: 'border-indigo-500/25', label: 'text-indigo-200' }
};

function getSafeAiMessage(error, fallback) {
  if (error?.provider && error?.message) return error.message;
  const raw = typeof error === 'string' ? error : (error?.message || '');
  const normalized = (raw || '').toLowerCase();

  if (!raw) return fallback;
  if (/not configured|missing.*key|api key|unauthorized|forbidden|authentication|invalid api/i.test(normalized)) {
    return 'The AI service is not configured correctly. Please try again later.';
  }
  if (/model .* does not exist|does not exist|invalid model|unknown model|unsupported model/i.test(normalized)) {
    return 'The selected AI model is unavailable right now. Please try again shortly.';
  }
  if (/rate limit|quota|too many requests|temporar|timeout|network|service unavailable|overloaded|connection/i.test(normalized)) {
    return 'The AI service is temporarily busy. Please try again in a moment.';
  }
  return fallback;
}

export default function App() {
  const [currentMember, setCurrentMember] = useState(null);
  const [legacyMembers, setLegacyMembers] = useState([]);
  const [selectedLegacyMemberId, setSelectedLegacyMemberId] = useState('');
  const [legacyImportPassword, setLegacyImportPassword] = useState('');
  const [legacyImportError, setLegacyImportError] = useState('');
  const [isLegacyImporting, setIsLegacyImporting] = useState(false);
  const [legacyArchive, setLegacyArchive] = useState(null);
  const [plannerData, setPlannerData] = useState(() => createEmptyPlannerState());
  const [aiScheduleDailyMinutes, setAiScheduleDailyMinutes] = useState(180);
  const [aiStudySchedule, setAiStudySchedule] = useState(null);
  const [isAiScheduleLoading, setIsAiScheduleLoading] = useState(false);
  const [aiScheduleError, setAiScheduleError] = useState('');
  const [showFullAiSchedule, setShowFullAiSchedule] = useState(false);
  const [aiScheduleRefreshToken, setAiScheduleRefreshToken] = useState(0);
  const [plannerMonth, setPlannerMonth] = useState(new Date().getMonth());
  const [plannerYear, setPlannerYear] = useState(new Date().getFullYear());
  const [plannerSelectedDate, setPlannerSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [plannerTaskForm, setPlannerTaskForm] = useState({
    subject: 'Arithmetic',
    topic: 'Percentages',
    date: new Date().toISOString().split('T')[0],
    startTime: '19:00',
    endTime: '20:00',
    duration: 60,
    priority: 'MEDIUM',
    notes: '',
    status: 'scheduled'
  });
  const [isMemberHydrated, setIsMemberHydrated] = useState(false);
  const [accountDataError, setAccountDataError] = useState('');
  const authLoadSequenceRef = useRef(0);
  const plannerSaveQueueRef = useRef(Promise.resolve());
  const answerSaveQueueRef = useRef(Promise.resolve());
  const plannerDirtyRef = useRef(false);
  const plannerRevisionRef = useRef(0);
  const plannerSaveFailedRef = useRef(false);
  const answerSaveFailedRef = useRef(false);
  const submissionFailedRef = useRef(false);
  const aiScheduleRequestRef = useRef(0);

  // Application View Navigation
  const [currentView, setCurrentView] = useState('login'); // 'login', 'signup', 'dashboard', 'topics', 'topic-detail', 'test', 'result', 'ai-tutor', 'profile'
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [selectedExam, setSelectedExam] = useState('SI'); // 'SI' or 'CONSTABLE'
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [selectedSubject, setSelectedSubject] = useState(Object.keys(SUBJECT_TOPICS)[0] || '');
  const [selectedTopic, setSelectedTopic] = useState(SUBJECT_TOPICS[Object.keys(SUBJECT_TOPICS)[0]]?.[0] || '');
  const [showStudyNotes, setShowStudyNotes] = useState(false);
  const [learningVideos, setLearningVideos] = useState([]);
  const [activeTopicVideo, setActiveTopicVideo] = useState(null);
  const [isLoadingLearningVideos, setIsLoadingLearningVideos] = useState(false);
  const [learningVideosError, setLearningVideosError] = useState('');
  const [studyNotes, setStudyNotes] = useState(null);
  const [selectedNotesLearningStage, setSelectedNotesLearningStage] = useState('');
  const [isLoadingStudyNotes, setIsLoadingStudyNotes] = useState(false);
  const [studyNotesError, setStudyNotesError] = useState('');
  const [notesDoubtMessages, setNotesDoubtMessages] = useState([]);
  const [notesDoubtInput, setNotesDoubtInput] = useState('');
  const [isNotesDoubtLoading, setIsNotesDoubtLoading] = useState(false);
  const [notesDoubtError, setNotesDoubtError] = useState('');
  const notesAudioTextRef = useRef('');
  const [isNotesAudioPlaying, setIsNotesAudioPlaying] = useState(false);
  const [activeAttemptId, setActiveAttemptId] = useState(null);
  const [completedAttempt, setCompletedAttempt] = useState(null);
  const [activeTestMode, setActiveTestMode] = useState('topic');
  const [activeTestDurationSeconds, setActiveTestDurationSeconds] = useState(600);
  const [revisionMockQuestionCount, setRevisionMockQuestionCount] = useState(60);
  const [revisionMockDurationMinutes, setRevisionMockDurationMinutes] = useState(60);
  const [revisionMockMode, setRevisionMockMode] = useState('revision-mock');
  const [savedQuestions, setSavedQuestions] = useState([]);
  const [selectedBookmarkIds, setSelectedBookmarkIds] = useState([]);
  const [bookmarkPracticeDuration, setBookmarkPracticeDuration] = useState(30);
  const [isSavingBookmarks, setIsSavingBookmarks] = useState(false);
  const [textScale, setTextScale] = useState(() => {
    try { return localStorage.getItem('prep-text-scale') || '16px'; } catch { return '16px'; }
  });
  const [highContrast, setHighContrast] = useState(() => {
    try { return localStorage.getItem('prep-high-contrast') === 'true'; } catch { return false; }
  });
  const THEME_OPTIONS = [
    { id: 'midnight', label: 'Midnight', swatch: '#0f172a' },
    { id: 'ocean', label: 'Ocean', swatch: '#0f766e' },
    { id: 'sunset', label: 'Sunset', swatch: '#f97316' },
    { id: 'forest', label: 'Forest', swatch: '#16a34a' },
    { id: 'violet', label: 'Violet', swatch: '#8b5cf6' },
    { id: 'rose', label: 'Rose', swatch: '#f43f5e' },
    { id: 'aurora', label: 'Aurora', swatch: '#22c55e' },
    { id: 'gold', label: 'Gold', swatch: '#fbbf24' },
    { id: 'monochrome', label: 'Monochrome', swatch: '#94a3b8' },
    { id: 'cyber', label: 'Cyber', swatch: '#06b6d4' }
  ];
  const [activeTheme, setActiveTheme] = useState(() => {
    try { return localStorage.getItem('prep-theme') || 'midnight'; } catch { return 'midnight'; }
  });

  useEffect(() => {
    const interval = setInterval(() => setCountdownNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    document.documentElement.style.fontSize = ['16px', '18px', '20px'].includes(textScale) ? textScale : '16px';
    document.documentElement.dataset.highContrast = String(highContrast);
    document.documentElement.dataset.theme = activeTheme;
    try {
      localStorage.setItem('prep-text-scale', textScale);
      localStorage.setItem('prep-high-contrast', String(highContrast));
      localStorage.setItem('prep-theme', activeTheme);
    } catch (error) {
      console.warn('Accessibility and theme preferences could not be saved in this browser.', error);
    }
    return () => {
      delete document.documentElement.dataset.highContrast;
      document.documentElement.style.fontSize = '';
      document.documentElement.dataset.theme = 'midnight';
    };
  }, [textScale, highContrast, activeTheme]);

  useEffect(() => {
    const members = readLegacyMembers();
    setLegacyMembers(members);
    setSelectedLegacyMemberId(members[0]?.id || '');
  }, []);

  // Global Counter for guaranteed fresh attempt seeds
  const [testAttemptCounter, setTestAttemptCounter] = useState(0);

  // User Progression State
  const [userProgress, setUserProgress] = useState({});
  const [testHistory, setTestHistory] = useState([]);

  // Active Test Engine States
  const [activeTestQuestions, setActiveTestQuestions] = useState([]);
  const [userAnswers, setUserAnswers] = useState({});
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(600); // 10 minutes
  const [showExamFocusWarning, setShowExamFocusWarning] = useState(false);
  const [isSubmitModalOpen, setIsSubmitModalOpen] = useState(false);
  const [isSubmittingTest, setIsSubmittingTest] = useState(false);
  const submissionInProgressRef = useRef(false);
  const examAudioContextRef = useRef(null);
  const focusAwayRef = useRef(false);
  const focusAwayTimerRef = useRef(null);
  const halfTimeAlertPlayedRef = useRef(false);
  const finalMinuteAlertsPlayedRef = useRef(new Set());
  const [activeTestDifficulty, setActiveTestDifficulty] = useState("Beginner");
  const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);
  const [questionGenerationNotice, setQuestionGenerationNotice] = useState('');
  const [questionGenerationError, setQuestionGenerationError] = useState('');

  // AI Modal & Tutor
  const [aiModalContent, setAiModalContent] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [reviewChatQuestionId, setReviewChatQuestionId] = useState(null);
  const [reviewChatMessages, setReviewChatMessages] = useState([]);
  const [reviewChatInput, setReviewChatInput] = useState('');
  const [isReviewChatLoading, setIsReviewChatLoading] = useState(false);
  const [showDevModal, setShowDevModal] = useState(false);
  const [driveRootFolderId, setDriveRootFolderId] = useState('');
  const [driveCurrentFolderId, setDriveCurrentFolderId] = useState('');
  const [driveCurrentFolders, setDriveCurrentFolders] = useState([]);
  const [driveCurrentFiles, setDriveCurrentFiles] = useState([]);
  const [driveBreadcrumbs, setDriveBreadcrumbs] = useState([]);
  const [driveCurrentSubject, setDriveCurrentSubject] = useState('');
  const [driveCurrentTopic, setDriveCurrentTopic] = useState('');
  const [isDriveNotesLoading, setIsDriveNotesLoading] = useState(false);
  const initialDriveQueryState = useMemo(() => getDriveQueryState(), []);
  const [driveNotesError, setDriveNotesError] = useState(() => initialDriveQueryState?.notesError ?? '');
  const [isGoogleDriveConnected, setIsGoogleDriveConnected] = useState(() => initialDriveQueryState?.connected ?? false);
  const [driveConnectionStatus, setDriveConnectionStatus] = useState(() => initialDriveQueryState?.connectionStatus ?? 'checking');
  const [driveAdminAuthConfigured, setDriveAdminAuthConfigured] = useState(false);
  const [isDriveAdminAuthorized, setIsDriveAdminAuthorized] = useState(false);
  const [isDriveAdminStatusLoaded, setIsDriveAdminStatusLoaded] = useState(false);
  const [driveAdminKey, setDriveAdminKey] = useState('');
  const [driveAdminError, setDriveAdminError] = useState('');
  const [isDriveAdminLoggingIn, setIsDriveAdminLoggingIn] = useState(false);
  const [adminVideoContext, setAdminVideoContext] = useState(() => {
    const subject = Object.keys(SUBJECT_TOPICS)[0] || '';
    return { exam: 'SI', subject, topic: SUBJECT_TOPICS[subject]?.[0] || '' };
  });
  const [adminLearningVideos, setAdminLearningVideos] = useState([]);
  const [activeLibraryVideo, setActiveLibraryVideo] = useState(null);
  const [isLoadingAdminVideos, setIsLoadingAdminVideos] = useState(false);
  const [adminVideoError, setAdminVideoError] = useState('');
  const [adminVideoNotice, setAdminVideoNotice] = useState('');
  const [adminVideoForm, setAdminVideoForm] = useState({ id: '', title: '', youtubeUrl: '' });
  const [isSavingAdminVideo, setIsSavingAdminVideo] = useState(false);
  const [adminVideoDeleteId, setAdminVideoDeleteId] = useState('');
  const [isDeletingAdminVideo, setIsDeletingAdminVideo] = useState(false);
  const [isDriveAuthStarting, setIsDriveAuthStarting] = useState(false);
  const [isDriveUploading, setIsDriveUploading] = useState(false);
  const [driveUploadMessage, setDriveUploadMessage] = useState('');
  const [drivePreviewFile, setDrivePreviewFile] = useState(null);
  const [isDrivePreviewFullscreen, setIsDrivePreviewFullscreen] = useState(false);
  const driveRequestSequenceRef = useRef(0);
  const drivePreviewContainerRef = useRef(null);
  const notesDoubtLogRef = useRef(null);
  const answerSaveTimerRef = useRef(null);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsDrivePreviewFullscreen(document.fullscreenElement === drivePreviewContainerRef.current);
    };
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  useEffect(() => {
    if (currentView !== 'test' || !activeAttemptId) return undefined;
    const answers = Object.fromEntries(
      Object.entries(userAnswers).filter(([questionId, answer]) => activeTestQuestions.some((question) => question.id === questionId) && typeof answer === 'string')
    );
    answerSaveTimerRef.current = setTimeout(() => {
      answerSaveQueueRef.current = answerSaveQueueRef.current
        .catch(() => undefined)
        .then(() => saveTestAnswers(activeAttemptId, answers))
        .then(() => {
          answerSaveFailedRef.current = false;
          setAccountDataError('');
        })
        .catch((error) => {
          answerSaveFailedRef.current = true;
          setAccountDataError(error.message || 'Unable to save your answers. Keep this test open and retry.');
        });
    }, 350);
    return () => clearTimeout(answerSaveTimerRef.current);
  }, [currentView, activeAttemptId, activeTestQuestions, userAnswers]);

  useEffect(() => {
    const doubtLog = notesDoubtLogRef.current;
    if (doubtLog) doubtLog.scrollTop = doubtLog.scrollHeight;
  }, [notesDoubtMessages, isNotesDoubtLoading]);

  useEffect(() => {
    const syncDriveConnectionState = async () => {
      try {
        const status = await checkDriveConnection();
        setIsGoogleDriveConnected(Boolean(status.connected));
        setDriveConnectionStatus(status.available ? 'connected' : status.connected ? 'error' : status.code && !['AUTH_REQUIRED', 'DRIVE_AUTH_FAILED'].includes(status.code) ? 'error' : 'not-connected');
        setDriveAdminAuthConfigured(Boolean(status.adminAuthConfigured));
        setIsDriveAdminAuthorized(Boolean(status.adminAuthorized));
        if (status.adminAuthorized) setIsLoadingAdminVideos(true);
      } catch {
        setIsGoogleDriveConnected(false);
        setDriveConnectionStatus('error');
        setDriveAdminAuthConfigured(false);
        setIsDriveAdminAuthorized(false);
      } finally {
        setIsDriveAdminStatusLoaded(true);
      }
    };
    void syncDriveConnectionState();
  }, []);

  useEffect(() => {
    if (!currentMember?.id || currentView !== 'drive-notes') return undefined;
    let active = true;
    getAdminLearningVideos(adminVideoContext.exam, adminVideoContext.subject, adminVideoContext.topic)
      .then(({ videos }) => {
        if (active) setAdminLearningVideos(Array.isArray(videos) ? videos : []);
      })
      .catch(() => {
        if (active) setAdminVideoError('Unable to load learning videos. Please try again.');
      })
      .finally(() => {
        if (active) setIsLoadingAdminVideos(false);
      });
    return () => {
      active = false;
    };
  }, [currentView, currentMember?.id, adminVideoContext]);

  useEffect(() => {
    let active = true;
    const requestGeneration = ++authLoadSequenceRef.current;
    const restoreCandidateSession = async () => {
      try {
        const { user } = await getCurrentCandidate();
        const { data } = await getCurrentCandidateData();
        if (!active || requestGeneration !== authLoadSequenceRef.current) return;
        loadMember(user, data);
      } catch (error) {
        if (!active || requestGeneration !== authLoadSequenceRef.current) return;
        if (error.code !== 'AUTH_REQUIRED') {
          const message = error.message || 'Unable to connect to the server. Please try again.';
          setAccountDataError(message);
          setAuthError(message);
        }
      } finally {
        if (active && requestGeneration === authLoadSequenceRef.current) setIsMemberHydrated(true);
      }
    };
    void restoreCandidateSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (currentView !== 'topic-detail' || !currentMember?.id || !selectedSubject || !selectedTopic) return undefined;
    let active = true;
    getTopicLearningVideos(selectedSubject, selectedTopic)
      .then(({ videos }) => {
        if (active) setLearningVideos(Array.isArray(videos) ? videos : []);
      })
      .catch(() => {
        if (active) setLearningVideosError('Unable to load learning videos right now.');
      })
      .finally(() => {
        if (active) setIsLoadingLearningVideos(false);
      });
    return () => {
      active = false;
    };
  }, [currentView, currentMember?.id, selectedExam, selectedSubject, selectedTopic]);

  useEffect(() => {
    if (currentView !== 'test' || !activeAttemptId) {
      focusAwayRef.current = false;
      clearTimeout(focusAwayTimerRef.current);
      return undefined;
    }

    let documentHidden = document.visibilityState === 'hidden';
    let windowBlurred = !document.hasFocus();
    const updateFocus = () => {
      if (documentHidden || windowBlurred) {
        if (focusAwayRef.current) return;
        focusAwayRef.current = true;
        focusAwayTimerRef.current = setTimeout(() => {
          focusAwayTimerRef.current = null;
          setShowExamFocusWarning(true);
          playExamBuzzer(examAudioContextRef.current);
        }, 10_000);
        return;
      }
      if (!focusAwayRef.current) return;
      focusAwayRef.current = false;
      clearTimeout(focusAwayTimerRef.current);
      focusAwayTimerRef.current = null;
      setShowExamFocusWarning(false);
    };
    const handleVisibilityChange = () => {
      documentHidden = document.visibilityState === 'hidden';
      updateFocus();
    };
    const handleBlur = () => {
      windowBlurred = true;
      updateFocus();
    };
    const handleFocus = () => {
      windowBlurred = false;
      updateFocus();
    };
    const unlockAudio = () => initializeExamAudio(examAudioContextRef);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    updateFocus();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('pointerdown', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      focusAwayRef.current = false;
      clearTimeout(focusAwayTimerRef.current);
      focusAwayTimerRef.current = null;
      const audioContext = examAudioContextRef.current;
      examAudioContextRef.current = null;
      if (audioContext && audioContext.state !== 'closed') void audioContext.close().catch(() => undefined);
    };
  }, [currentView, activeAttemptId]);

  useEffect(() => {
    if (currentView !== 'test' || !activeAttemptId) {
      halfTimeAlertPlayedRef.current = false;
      finalMinuteAlertsPlayedRef.current.clear();
      return;
    }
    if (timeRemaining <= activeTestDurationSeconds / 2 && !halfTimeAlertPlayedRef.current) {
      halfTimeAlertPlayedRef.current = true;
      playExamTone(examAudioContextRef.current);
    }
    if ([60, 50, 40, 30, 20, 10].includes(timeRemaining) && !finalMinuteAlertsPlayedRef.current.has(timeRemaining)) {
      finalMinuteAlertsPlayedRef.current.add(timeRemaining);
      playExamTone(examAudioContextRef.current, { frequency: 880, duration: 0.16, volume: 0.1 });
    }
  }, [currentView, activeAttemptId, activeTestDurationSeconds, timeRemaining]);

  const clearAccountSpecificState = () => {
    setSelectedExam('SI');
    setUserProgress({});
    setTestHistory([]);
    setSavedQuestions([]);
    setSelectedBookmarkIds([]);
    setTestAttemptCounter(0);
    setActiveAttemptId(null);
    setCompletedAttempt(null);
    setActiveTestQuestions([]);
    setUserAnswers({});
    setCurrentQuestionIdx(0);
    setTimeRemaining(600);
    setQuestionGenerationNotice('');
    setQuestionGenerationError('');
    setStudyNotes(null);
    setStudyNotesError('');
    setNotesDoubtMessages([]);
    setNotesDoubtInput('');
    setDriveNotesError('');
    setDriveCurrentFolderId('');
    setDriveCurrentFolders([]);
    setDriveCurrentFiles([]);
    setDriveBreadcrumbs([]);
    setDriveCurrentSubject('');
    setDriveCurrentTopic('');
    setDrivePreviewFile(null);
    setPlannerData(createEmptyPlannerState());
    setAiScheduleDailyMinutes(180);
    setAiStudySchedule(null);
    setAiScheduleError('');
    setLegacyArchive(null);
    setPlannerSelectedDate(new Date().toISOString().split('T')[0]);
  };

  const plannerViewData = useMemo(() => {
    if (!currentMember) return plannerData || createEmptyPlannerState();
    return mergePlannerSnapshot(plannerData, { ...currentMember, userProgress, testHistory }, selectedExam);
  }, [currentMember, selectedExam, plannerData, userProgress, testHistory]);
  const aiScheduleTodayKey = getLocalDateKey(new Date(countdownNow));
  const aiScheduleInput = useMemo(() => {
    const today = new Date(`${aiScheduleTodayKey}T12:00:00`);
    return {
      topicMetrics: plannerViewData?.topicMetrics || [],
      examType: selectedExam,
      dailyMinutes: aiScheduleDailyMinutes,
      daysRemaining: daysRemainingForExam(selectedExam, today),
      today
    };
  }, [plannerViewData, selectedExam, aiScheduleDailyMinutes, aiScheduleTodayKey]);
  const aiScheduleInputKey = JSON.stringify({
    examType: aiScheduleInput.examType,
    dailyMinutes: aiScheduleInput.dailyMinutes,
    daysRemaining: aiScheduleInput.daysRemaining,
    today: getLocalDateKey(aiScheduleInput.today),
    topicMetrics: aiScheduleInput.topicMetrics.map(({ subject, topic, weightage, accuracy, completion, recentAccuracy, attempted, recommendedMinutes, priority }) => [
      subject, topic, weightage, accuracy, completion, recentAccuracy, attempted, recommendedMinutes, priority
    ])
  });
  const selectedPlannerTasks = (plannerViewData?.schedule || []).filter((task) => (task.examType || plannerViewData?.examType) === selectedExam);

  useEffect(() => {
    if (currentView !== 'ai-schedule' || !currentMember) return undefined;
    const requestId = ++aiScheduleRequestRef.current;
    let cancelled = false;
    const generateSchedule = async () => {
      setIsAiScheduleLoading(true);
      setAiScheduleError('');
      setAiStudySchedule(null);
      try {
        const reply = await sendChatMessage({
          exam: normalizeExamForRequest(aiScheduleInput.examType),
          subject: 'General Studies',
          topic: 'Full syllabus study schedule',
          difficulty: 'Personalized',
          syllabus: SUBJECT_TOPICS,
          messages: [{
            role: 'user',
            content: buildAiSchedulePrompt(aiScheduleInput.topicMetrics, aiScheduleInput)
          }]
        });
        const aiPlan = parseAiScheduleResponse(reply, aiScheduleInput.topicMetrics.length);
        const schedule = buildAiStudySchedule(aiScheduleInput.topicMetrics, aiPlan.priorityTopicIds, aiScheduleInput);
        if (!cancelled && requestId === aiScheduleRequestRef.current) {
          setAiStudySchedule({ ...schedule, strategy: aiPlan.strategy, generatedAt: new Date().toISOString() });
        }
      } catch (error) {
        if (!cancelled && requestId === aiScheduleRequestRef.current) {
          setAiScheduleError(getSafeAiMessage(error, 'Unable to create your AI study schedule. Please try again.'));
        }
      } finally {
        if (!cancelled && requestId === aiScheduleRequestRef.current) setIsAiScheduleLoading(false);
      }
    };
    void generateSchedule();
    return () => {
      cancelled = true;
      if (requestId === aiScheduleRequestRef.current) aiScheduleRequestRef.current += 1;
    };
  }, [currentView, currentMember, aiScheduleInput, aiScheduleInputKey, aiScheduleRefreshToken]);

  const savePlannerSnapshot = useEffectEvent(async (snapshot) => {
    try {
      const saved = await saveCurrentCandidatePlanner(snapshot, plannerRevisionRef.current);
      plannerRevisionRef.current = Number(saved.plannerRevision) || plannerRevisionRef.current + 1;
      plannerDirtyRef.current = false;
      plannerSaveFailedRef.current = false;
      setAccountDataError('');
    } catch (error) {
      if (error.code === 'DATA_CONFLICT') {
        try {
          const { data } = await getCurrentCandidateData();
          plannerRevisionRef.current = Number(data.plannerRevision) || 0;
          plannerSaveFailedRef.current = false;
          setPlannerData(data.plannerData || createEmptyPlannerState(currentMember));
          setAccountDataError('Your planner changed on another device. The latest saved version has been loaded.');
          return;
        } catch {
          plannerSaveFailedRef.current = true;
          setAccountDataError('Your planner changed elsewhere and could not be refreshed. Retry before continuing.');
          return;
        }
      }
      plannerSaveFailedRef.current = true;
      setAccountDataError(error.message || 'Unable to save your planner. Your current data remains on this screen.');
    }
  });

  useEffect(() => {
    if (!currentMember || !isMemberHydrated || !plannerDirtyRef.current) return;
    plannerSaveQueueRef.current = plannerSaveQueueRef.current
      .catch(() => undefined)
      .then(() => savePlannerSnapshot(plannerViewData));
  }, [currentMember, isMemberHydrated, plannerViewData]);

  function loadMember(user, data) {
    if (!user?.userId || !data) return;
    const member = { ...user, id: user.userId, exam: data.exam || 'SI' };
    const plannerSnapshot = data.legacyArchive?.verified === false
      ? createEmptyPlannerState(member)
      : data.plannerData || createEmptyPlannerState(member);
    plannerDirtyRef.current = false;
    plannerRevisionRef.current = Number(data.plannerRevision) || 0;
    plannerSaveFailedRef.current = false;
    answerSaveFailedRef.current = false;
    submissionFailedRef.current = false;
    setAccountDataError('');
    setAuthError('');
    setAuthSuccess('');
    setCurrentMember(member);
    setLegacyArchive(data.legacyArchive || null);
    setPlannerData(plannerSnapshot);
    setAiScheduleDailyMinutes(Number(plannerSnapshot.aiScheduleDailyMinutes) || 180);
    setAiStudySchedule(null);
    setSelectedExam(data.exam || 'SI');
    const loadedHistory = (data.testHistory || []).map((attempt) => ({ ...attempt, id: attempt.id || attempt.attemptId }));
    setUserProgress(normalizeUserProgress(data.userProgress || {}, member.exam, loadedHistory, SUBJECT_TOPICS));
    setTestHistory(loadedHistory);
    setSavedQuestions(Array.isArray(data.savedQuestions) ? data.savedQuestions : []);
    setTestAttemptCounter(Number(data.testAttemptCounter) || 0);
    const activeAttempt = data.activeAttempt?.status === 'in_progress' ? data.activeAttempt : null;
    setActiveAttemptId(activeAttempt?.attemptId || null);
    setCompletedAttempt(null);
    setActiveTestQuestions(activeAttempt?.questions || []);
    setActiveTestMode(activeAttempt?.mode || 'topic');
    setActiveTestDurationSeconds(Number(activeAttempt?.durationSeconds) || 600);
    setUserAnswers(activeAttempt?.answers || {});
    setCurrentQuestionIdx(0);
    const elapsed = activeAttempt?.startedAt ? Math.floor((Date.now() - Date.parse(activeAttempt.startedAt)) / 1000) : 0;
    setTimeRemaining(Math.max(0, (Number(activeAttempt?.durationSeconds) || 600) - (Number.isFinite(elapsed) ? elapsed : 0)));
    setSelectedSubject(activeAttempt?.subject || Object.keys(SUBJECT_TOPICS)[0]);
    setSelectedTopic(activeAttempt?.topic || SUBJECT_TOPICS[Object.keys(SUBJECT_TOPICS)[0]]?.[0] || '');
    setActiveTestDifficulty(activeAttempt?.difficulty || 'Beginner');
    setCurrentView(activeAttempt ? 'test' : 'dashboard');
  }

  const handleChangeExam = async (exam) => {
    if (!currentMember || !['SI', 'CONSTABLE'].includes(exam) || exam === selectedExam) return;
    const previousExam = selectedExam;
    if (currentView === 'topic-detail') {
      setLearningVideos([]);
      setLearningVideosError('');
      setIsLoadingLearningVideos(true);
    }
    setSelectedExam(exam);
    try {
      const { user } = await updateCurrentCandidateProfile({ name: currentMember.name, exam });
      setCurrentMember((previous) => previous ? { ...previous, ...user, id: previous.id } : previous);
      setAccountDataError('');
    } catch (error) {
      setSelectedExam(previousExam);
      setAccountDataError(error.message || 'Unable to save your exam preference. Please retry.');
    }
  };

  const handleLogout = async () => {
    if (!currentMember) return;
    try {
      clearTimeout(answerSaveTimerRef.current);
      await plannerSaveQueueRef.current;
      await answerSaveQueueRef.current;
      if (currentView === 'test' && activeAttemptId) {
        const activeQuestionIds = new Set(activeTestQuestions.map((question) => question.id).filter(Boolean));
        const answers = Object.fromEntries(Object.entries(userAnswers).filter(([questionId]) => activeQuestionIds.has(questionId)));
        await saveTestAnswers(activeAttemptId, answers);
        answerSaveFailedRef.current = false;
      }
      if (plannerSaveFailedRef.current || answerSaveFailedRef.current) {
        setAccountDataError('Some changes are not saved yet. Retry saving before signing out.');
        return;
      }
      await logoutCandidate();
    } catch (error) {
      setAccountDataError(error.message || 'Unable to sign out. Please try again.');
      return;
    }
    authLoadSequenceRef.current += 1;
    plannerSaveFailedRef.current = false;
    answerSaveFailedRef.current = false;
    submissionFailedRef.current = false;
    clearAccountSpecificState();
    setPlannerData(createEmptyPlannerState());
    setCurrentMember(null);
    setAuthPassword('');
    setAuthError('');
    setAuthSuccess('');
    setAccountDataError('');
    setCurrentView('login');
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    if (isAuthenticating) return;

    setAuthError('');
    setAuthSuccess('');
    setIsAuthenticating(true);

    try {
      let response;
      if (currentView === 'signup') {
        const name = authName.trim();
        if (!name) throw new Error('Enter your name to create an account.');
        if (authPassword.length < 8 || authPassword.length > 128) throw new Error('Use a password with 8 to 128 characters.');
        response = await signUpCandidate({ name, email: authEmail, password: authPassword });
        setAuthPassword('');
        setCurrentView('login');
        setAuthSuccess(response.message || 'Signup request complete. Please sign in to continue.');
        return;
      } else {
        response = await loginCandidate({ email: authEmail, password: authPassword });
      }
      const { data } = await getCurrentCandidateData();
      loadMember(response.user, data);
      setAuthPassword('');
      setAuthError('');
    } catch (error) {
      setAuthError(error.message || 'Unable to connect to the server. Please try again.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleLegacyImport = async (event) => {
    event.preventDefault();
    if (isLegacyImporting) return;
    const legacyRecord = legacyMembers.find((member) => member.id === selectedLegacyMemberId);
    if (!legacyRecord) {
      setLegacyImportError('Select a saved account from this browser.');
      return;
    }
    if (!legacyImportPassword) {
      setLegacyImportError('Enter the password used by the old account.');
      return;
    }
    setLegacyImportError('');
    setIsLegacyImporting(true);
    try {
      await importLegacyCandidate({ legacyRecord, password: legacyImportPassword });
      const [{ user }, { data }] = await Promise.all([getCurrentCandidate(), getCurrentCandidateData()]);
      loadMember(user, data);
      if (!removeImportedLegacyMember(legacyRecord)) {
        setLegacyImportError('Your account was imported, but this browser copy could not be removed. Retry import to safely finish cleanup.');
        return;
      }
      const remaining = readLegacyMembers();
      setLegacyMembers(remaining);
      setSelectedLegacyMemberId(remaining[0]?.id || '');
      setLegacyImportPassword('');
      setLegacyImportError('');
    } catch (error) {
      setLegacyImportError(error.message || 'The saved account could not be imported. Your browser copy is unchanged.');
    } finally {
      setIsLegacyImporting(false);
    }
  };

  // Launch a fresh AI-generated test.
  const handleStartTest = async (topic, difficulty) => {
    if (isGeneratingQuestions) return;
    if (!selectedSubject || !selectedExam || !topic || !difficulty) {
      setQuestionGenerationError('Please select a valid subject, topic, and difficulty before generating questions.');
      return;
    }

    setSelectedTopic(topic);
    setActiveTestDifficulty(difficulty);
    initializeExamAudio(examAudioContextRef);
    halfTimeAlertPlayedRef.current = false;
    finalMinuteAlertsPlayedRef.current.clear();
    setShowExamFocusWarning(false);
    setIsGeneratingQuestions(true);
    setQuestionGenerationError('');
    setQuestionGenerationNotice('Generating Question...');
    setCompletedAttempt(null);
    submissionInProgressRef.current = false;
    setIsSubmittingTest(false);

    try {
      const { attempt } = await createTestAttempt({
        exam: normalizeExamForRequest(selectedExam),
        subject: selectedSubject,
        topic,
        difficulty
      });
      if (!attempt?.attemptId || !Array.isArray(attempt.questions) || attempt.questions.length !== 10) {
        throw new Error('The server returned an invalid test. Please try again.');
      }
      setQuestionGenerationNotice('Fresh AI-generated questions loaded.');

      setTestAttemptCounter((previous) => previous + 1);
      setActiveAttemptId(attempt.attemptId);
      setActiveTestQuestions(attempt.questions);
      setActiveTestMode('topic');
      setActiveTestDurationSeconds(600);
      setUserAnswers({});
      setCurrentQuestionIdx(0);
      setTimeRemaining(600); // 10 minutes
      setCurrentView('test');
    } catch (error) {
      setQuestionGenerationError(getSafeAiMessage(error, 'Question generation failed. Please try again.'));
      setQuestionGenerationNotice('AI question generation failed.');
    } finally {
      setIsGeneratingQuestions(false);
    }
  };

  const handleStartRevisionMockTest = async (mode = revisionMockMode) => {
    if (isGeneratingQuestions) return;
    if (!selectedExamProgress.length) {
      setQuestionGenerationError('Practice at least one syllabus topic before starting a revision mock test.');
      return;
    }

    initializeExamAudio(examAudioContextRef);
    halfTimeAlertPlayedRef.current = false;
    finalMinuteAlertsPlayedRef.current.clear();
    setShowExamFocusWarning(false);
    setIsGeneratingQuestions(true);
    setQuestionGenerationError('');
    setQuestionGenerationNotice(mode === 'exam-day'
      ? 'Preparing an exam-day practice simulation from your practiced topics...'
      : 'Preparing a weighted revision test from your practiced topics...');
    setCompletedAttempt(null);
    submissionInProgressRef.current = false;
    setIsSubmittingTest(false);

    try {
      const { attempt } = await createRevisionMockAttempt({
        exam: normalizeExamForRequest(selectedExam),
        questionCount: revisionMockQuestionCount,
        durationMinutes: revisionMockDurationMinutes,
        mode
      });
      if (!attempt?.attemptId || attempt.mode !== mode
        || !Array.isArray(attempt.questions) || attempt.questions.length !== revisionMockQuestionCount) {
        throw new Error('The server returned an invalid revision test. Please try again.');
      }

      setTestAttemptCounter((previous) => previous + Math.ceil(revisionMockQuestionCount / 10));
      setActiveAttemptId(attempt.attemptId);
      setActiveTestQuestions(attempt.questions);
      setActiveTestMode(mode);
      setActiveTestDurationSeconds(revisionMockDurationMinutes * 60);
      setUserAnswers({});
      setCurrentQuestionIdx(0);
      setTimeRemaining(revisionMockDurationMinutes * 60);
      setQuestionGenerationNotice(mode === 'exam-day' ? 'Exam-day simulation ready.' : 'Revision mock test ready.');
      setCurrentView('test');
    } catch (error) {
      setQuestionGenerationError(getSafeAiMessage(error, 'Practice test generation failed. Please try again.'));
      setQuestionGenerationNotice('Practice test generation failed.');
    } finally {
      setIsGeneratingQuestions(false);
    }
  };

  const handleLoadStudyNotes = async (forceRefresh = false, difficultyOverride = '') => {
    if (!selectedExam || !selectedSubject || !selectedTopic) {
      setStudyNotesError('Please select a valid subject and topic before generating notes.');
      return;
    }

    setShowStudyNotes(true);
    if ((studyNotes && !forceRefresh) || isLoadingStudyNotes) return;

    setIsLoadingStudyNotes(true);
    setStudyNotesError('');
    if (forceRefresh) setStudyNotes(null);
    try {
      const notes = await generateNotes({
        exam: normalizeExamForRequest(selectedExam),
        subject: selectedSubject,
        topic: selectedTopic,
        difficulty: difficultyOverride || selectedNotesLearningStage || currentTopicProgress.level || activeTestDifficulty || 'Beginner'
      });
      setStudyNotes(notes);
    } catch (error) {
      setStudyNotesError(getSafeAiMessage(error, 'Study notes generation failed. Please try again.'));
    } finally {
      setIsLoadingStudyNotes(false);
    }
  };

  const handleSelectNotesLearningStage = (stage) => {
    if (stage === currentLearningLevel) return;
    setSelectedNotesLearningStage(stage);
    if (studyNotes) {
      setShowStudyNotes(true);
      void handleLoadStudyNotes(true, stage);
    }
  };

  const stopNotesAudio = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    setIsNotesAudioPlaying(false);
  };

  const playNotesAudio = (text, label = 'AI notes explanation') => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setStudyNotesError('Audio explanation is not supported in this browser.');
      return;
    }
    const spokenText = String(text || '').trim();
    if (!spokenText) return;

    if (isNotesAudioPlaying) {
      stopNotesAudio();
      if (notesAudioTextRef.current === spokenText) return;
    }

    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang = 'en-IN';
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onstart = () => {
      notesAudioTextRef.current = spokenText;
      setIsNotesAudioPlaying(true);
    };
    utterance.onend = () => {
      notesAudioTextRef.current = '';
      setIsNotesAudioPlaying(false);
    };
    utterance.onerror = () => {
      notesAudioTextRef.current = '';
      setIsNotesAudioPlaying(false);
      setStudyNotesError(`Audio playback failed for ${label}. Please try again.`);
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  const handlePlayNotesAudio = () => {
    if (!studyNotes) return;
    const sections = [
      studyNotes.overview,
      ...((studyNotes.concepts || []).map((item) => `Concept: ${item}`)),
      ...((studyNotes.rules || []).map((item) => `Rule: ${item}`)),
      ...((studyNotes.formulas || []).map((item) => `Formula: ${item}`)),
      ...((studyNotes.examples || []).map((item) => `Example: ${item}`)),
      ...((studyNotes.shortcuts || []).map((item) => `Shortcut: ${item}`)),
      ...((studyNotes.commonMistakes || []).map((item) => `Common mistake: ${item}`)),
      ...((studyNotes.examTips || []).map((item) => `Exam tip: ${item}`)),
      ...((studyNotes.quickRevision || []).map((item) => `Quick revision: ${item}`))
    ].filter(Boolean);

    const explanation = [studyNotes.title, studyNotes.overview, ...sections].filter(Boolean).join('. ');
    playNotesAudio(explanation, studyNotes.title || 'AI notes explanation');
  };

  const handleSendNotesDoubt = async (promptOverride, retry = false) => {
    const question = String(promptOverride ?? notesDoubtInput).trim();
    if (!question || isNotesDoubtLoading) return;

    const nextMessages = retry
      ? notesDoubtMessages
      : [...notesDoubtMessages, { sender: 'user', text: question }];
    if (!retry) {
      setNotesDoubtMessages(nextMessages);
      setNotesDoubtInput('');
    }
    setNotesDoubtError('');
    setIsNotesDoubtLoading(true);

    const notesContext = studyNotes ? [
      studyNotes.overview && `Overview: ${studyNotes.overview}`,
      ...(studyNotes.concepts || []).map((item) => `Concept: ${item}`),
      ...(studyNotes.rules || []).map((item) => `Rule: ${item}`),
      ...(studyNotes.formulas || []).map((item) => `Formula: ${item}`),
      ...(studyNotes.examples || []).map((item) => `Example: ${item}`),
      ...(studyNotes.shortcuts || []).map((item) => `Shortcut: ${item}`),
      ...(studyNotes.commonMistakes || []).map((item) => `Common mistake: ${item}`),
      ...(studyNotes.examTips || []).map((item) => `Exam tip: ${item}`),
      ...(studyNotes.quickRevision || []).map((item) => `Quick revision: ${item}`)
    ].filter(Boolean).join('\n').slice(0, 5000) : '';
    const requestMessages = nextMessages.map((message, index) => ({
      role: message.sender === 'user' ? 'user' : 'assistant',
      content: message.sender === 'user' && index === nextMessages.length - 1
        ? `Student doubt: ${message.text}${notesContext ? `\n\nCurrent AI-generated notes for ${selectedSubject} / ${selectedTopic}:\n${notesContext}` : ''}`
        : message.text
    }));

    try {
      const reply = await sendChatMessage({
        exam: normalizeExamForRequest(selectedExam),
        subject: selectedSubject,
        topic: selectedTopic,
        difficulty: getTopicProgress(userProgress, selectedExam, selectedSubject, selectedTopic)?.level || activeTestDifficulty || 'Beginner',
        messages: requestMessages
      });
      setNotesDoubtMessages((previous) => [...previous, { sender: 'ai', text: reply }]);
    } catch (error) {
      setNotesDoubtError(getSafeAiMessage(error, 'Unable to answer right now. Please try again.'));
    } finally {
      setIsNotesDoubtLoading(false);
    }
  };

  const handleSelectOption = (questionId, option) => {
    const question = activeTestQuestions.find((item) => item.id === questionId);
    if (!question || !question.options.includes(option)) return;
    setUserAnswers(prev => ({ ...prev, [questionId]: option }));
  };

  const loadDriveFolder = async (folderId, breadcrumbs) => {
    const requestSequence = ++driveRequestSequenceRef.current;
    setIsDriveNotesLoading(true);
    setDriveNotesError('');
    setDriveCurrentFolders([]);
    setDriveCurrentFiles([]);
    setDriveCurrentFolderId(folderId);
    setDriveBreadcrumbs(breadcrumbs);
    try {
      const contents = await getDriveFolder(folderId);
      if (requestSequence !== driveRequestSequenceRef.current) return;
      setDriveCurrentFolders(contents.folders);
      setDriveCurrentFiles(contents.files);
    } catch (error) {
      if (requestSequence !== driveRequestSequenceRef.current) return;
      setDriveNotesError(error.message || 'Google Drive folder could not be loaded.');
    } finally {
      if (requestSequence === driveRequestSequenceRef.current) setIsDriveNotesLoading(false);
    }
  };

  const handleOpenDriveLibrary = async () => {
    setCurrentView('drive-notes');
    setIsLoadingAdminVideos(true);
    const requestSequence = ++driveRequestSequenceRef.current;
    setIsDriveNotesLoading(true);
    setDriveNotesError('');
    setDriveRootFolderId('');
    setDriveCurrentFolderId('');
    setDriveCurrentFolders([]);
    setDriveCurrentFiles([]);
    setDriveBreadcrumbs([]);
    setDriveCurrentSubject('');
    setDriveCurrentTopic('');
    try {
      const status = await getDriveStatus();
      if (requestSequence !== driveRequestSequenceRef.current) return;
      setDriveRootFolderId(status.rootFolderId);
      const contents = await getDriveFolder(status.rootFolderId);
      if (requestSequence !== driveRequestSequenceRef.current) return;
      setDriveCurrentFolderId(status.rootFolderId);
      setDriveBreadcrumbs([{ id: status.rootFolderId, name: 'Subjects' }]);
      setDriveCurrentFolders(contents.folders);
      setDriveCurrentFiles(contents.files);
    } catch (error) {
      if (requestSequence !== driveRequestSequenceRef.current) return;
      setDriveNotesError(error.message || 'Google Drive folders could not be loaded.');
    } finally {
      if (requestSequence === driveRequestSequenceRef.current) setIsDriveNotesLoading(false);
    }
  };

  const handleViewSelectedDriveNotes = async () => {
    const requestSequence = ++driveRequestSequenceRef.current;
    setCurrentView('drive-notes');
    setIsLoadingAdminVideos(true);
    setIsDriveNotesLoading(true);
    setDriveNotesError('');
    setDriveCurrentFolders([]);
    setDriveCurrentFiles([]);
    try {
      const result = await getDriveTopicFiles({
        exam: normalizeExamForRequest(selectedExam),
        subject: selectedSubject,
        topic: selectedTopic
      });
      if (requestSequence !== driveRequestSequenceRef.current) return;
      setDriveRootFolderId(result.rootFolder.id);
      setDriveCurrentFolderId(result.topicFolder.id);
      setDriveCurrentFolders([]);
      setDriveCurrentFiles(result.files);
      setDriveBreadcrumbs([
        { id: result.rootFolder.id, name: result.rootFolder.name },
        { id: result.subjectFolder.id, name: result.subjectFolder.name },
        { id: result.topicFolder.id, name: result.topicFolder.name }
      ]);
      setDriveCurrentSubject(result.subjectFolder.name);
      setDriveCurrentTopic(result.topicFolder.name);
      setIsGoogleDriveConnected(true);
      setDriveConnectionStatus('connected');
    } catch (error) {
      if (requestSequence !== driveRequestSequenceRef.current) return;
      setDriveNotesError(error.message || 'Google Drive notes could not be loaded.');
    } finally {
      if (requestSequence === driveRequestSequenceRef.current) setIsDriveNotesLoading(false);
    }
  };

  const handleRefreshDrive = async () => {
    setDriveNotesError('');
    try {
      const status = await checkDriveConnection();
      setIsGoogleDriveConnected(Boolean(status.connected));
      setDriveConnectionStatus(status.available ? 'connected' : status.connected ? 'error' : status.code && !['AUTH_REQUIRED', 'DRIVE_AUTH_FAILED'].includes(status.code) ? 'error' : 'not-connected');
      setDriveAdminAuthConfigured(Boolean(status.adminAuthConfigured));
      setIsDriveAdminAuthorized(Boolean(status.adminAuthorized));
      if (status.adminAuthorized) setIsLoadingAdminVideos(true);
      if (!status.available || !status.rootFolderId) {
        const sharedLibraryMessage = ['AUTH_REQUIRED', 'DRIVE_AUTH_FAILED', 'DRIVE_AUTH_REVOKED'].includes(status.code)
          ? 'The shared Notes Library is currently unavailable.'
          : status.message || 'Google Drive is not available right now.';
        setDriveNotesError(sharedLibraryMessage);
        return;
      }
      const folderId = driveCurrentFolderId || status.rootFolderId;
      const breadcrumbs = driveBreadcrumbs.length ? driveBreadcrumbs : [{ id: status.rootFolderId, name: 'Subjects' }];
      setDriveRootFolderId(status.rootFolderId);
      await loadDriveFolder(folderId, breadcrumbs);
    } catch (error) {
      setDriveConnectionStatus('error');
      setDriveNotesError(error.message || 'Google Drive could not be refreshed.');
    }
  };

  const handleDriveAdminLogin = async (event) => {
    event.preventDefault();
    if (!driveAdminKey || isDriveAdminLoggingIn) return;

    setIsDriveAdminLoggingIn(true);
    setDriveAdminError('');
    try {
      await loginDriveAdmin(driveAdminKey);
      setDriveAdminKey('');
      const status = await checkDriveConnection();
      setDriveAdminAuthConfigured(Boolean(status.adminAuthConfigured));
      setIsDriveAdminAuthorized(Boolean(status.adminAuthorized));
      if (status.adminAuthorized) setIsLoadingAdminVideos(true);
      setIsGoogleDriveConnected(Boolean(status.connected));
      setDriveConnectionStatus(status.available ? 'connected' : status.connected ? 'error' : status.code && !['AUTH_REQUIRED', 'DRIVE_AUTH_FAILED'].includes(status.code) ? 'error' : 'not-connected');
      if (!status.adminAuthorized) throw new Error('Administrator access could not be verified.');
      setDriveNotesError('');
      if (status.available && status.rootFolderId) {
        setDriveRootFolderId(status.rootFolderId);
        await loadDriveFolder(status.rootFolderId, [{ id: status.rootFolderId, name: 'Subjects' }]);
      }
    } catch (error) {
      setDriveAdminError(error.message || 'Administrator access could not be verified.');
    } finally {
      setDriveAdminKey('');
      setIsDriveAdminLoggingIn(false);
    }
  };

  const handleDriveAdminLogout = async () => {
    setDriveAdminError('');
    try {
      await logoutDriveAdmin();
      setIsDriveAdminAuthorized(false);
      setAdminLearningVideos([]);
    } catch (error) {
      setDriveAdminError(error.message || 'Administrator session could not be closed.');
    }
  };

  const handleSaveAdminVideo = async (event) => {
    event.preventDefault();
    if (isSavingAdminVideo || (!adminVideoForm.id && adminLearningVideos.length >= 5)) return;
    setIsSavingAdminVideo(true);
    setAdminVideoError('');
    setAdminVideoNotice('');
    try {
      const input = {
        title: adminVideoForm.title.trim() || `${adminVideoContext.topic} video`,
        youtubeUrl: adminVideoForm.youtubeUrl
      };
      const response = adminVideoForm.id
        ? await updateAdminLearningVideo(adminVideoForm.id, input)
        : await createAdminLearningVideo({ ...adminVideoContext, ...input });
      setAdminLearningVideos((previous) => {
        const next = adminVideoForm.id
          ? previous.map((video) => video.id === response.video.id ? response.video : video)
          : [...previous, response.video];
        return next.sort((left, right) => left.displayOrder - right.displayOrder);
      });
      setAdminVideoNotice(adminVideoForm.id ? 'Video updated successfully.' : 'Video added successfully.');
      setAdminVideoForm({ id: '', title: '', youtubeUrl: '' });
      setActiveLibraryVideo(response.video);
    } catch (error) {
      setAdminVideoError(error.code === 'TOPIC_VIDEO_LIMIT'
        ? 'Maximum 5 learning videos allowed for this topic.'
        : adminVideoForm.id ? 'Unable to update the video.' : 'Unable to add the video. Please try again.');
    } finally {
      setIsSavingAdminVideo(false);
    }
  };

  const handleDeleteAdminVideo = async () => {
    if (!adminVideoDeleteId || isDeletingAdminVideo) return;
    setIsDeletingAdminVideo(true);
    setAdminVideoError('');
    setAdminVideoNotice('');
    try {
      await deleteAdminLearningVideo(adminVideoDeleteId);
      setAdminLearningVideos((previous) => previous.filter((video) => video.id !== adminVideoDeleteId));
      setActiveLibraryVideo((video) => video?.id === adminVideoDeleteId ? null : video);
      setAdminVideoDeleteId('');
      setAdminVideoNotice('Video deleted successfully.');
    } catch {
      setAdminVideoError('Unable to delete the video.');
    } finally {
      setIsDeletingAdminVideo(false);
    }
  };

  const handleConnectGoogleDrive = async () => {
    if (!isDriveAdminAuthorized || isDriveAuthStarting) return;

    setIsDriveAuthStarting(true);
    setDriveAdminError('');
    try {
      const authUrl = await getDriveAuthUrl();
      window.location.assign(authUrl);
    } catch (error) {
      setDriveAdminError(error.message || 'Google Drive authorization could not be started.');
      setIsDriveAuthStarting(false);
    }
  };

  const handleCandidateDriveUpload = async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (driveBreadcrumbs.length !== 3 || !driveBreadcrumbs[1]?.id || driveCurrentFolderId !== driveBreadcrumbs[2]?.id) {
      setDriveNotesError('Choose an existing topic folder before sharing a note.');
      return;
    }

    setDriveNotesError('');
    setDriveUploadMessage('');
    setIsDriveUploading(true);
    try {
      const uploadedFile = await uploadDriveFile(driveCurrentFolderId, driveBreadcrumbs[1].id, file);
      setDriveUploadMessage(`${uploadedFile.name} is now shared in ${driveBreadcrumbs[2].name}.`);
      await loadDriveFolder(driveCurrentFolderId, driveBreadcrumbs);
    } catch (error) {
      setDriveNotesError(error.message || 'Your note could not be shared.');
    } finally {
      setIsDriveUploading(false);
    }
  };

  const handleOpenDriveFolder = (folder) => {
    setDriveUploadMessage('');
    const nextBreadcrumbs = [...driveBreadcrumbs, { id: folder.id, name: folder.name }];
    if (driveBreadcrumbs.length === 1) {
      setDriveCurrentSubject(folder.name);
      setDriveCurrentTopic('');
    } else if (driveBreadcrumbs.length === 2) {
      setDriveCurrentTopic(folder.name);
    }
    void loadDriveFolder(folder.id, nextBreadcrumbs);
  };

  const handleDriveBreadcrumbClick = (index) => {
    setDriveUploadMessage('');
    const nextBreadcrumbs = driveBreadcrumbs.slice(0, index + 1);
    setDriveCurrentSubject(nextBreadcrumbs[1]?.name || '');
    setDriveCurrentTopic(nextBreadcrumbs[2]?.name || '');
    void loadDriveFolder(nextBreadcrumbs[index].id, nextBreadcrumbs);
  };

  const handleDriveBack = () => {
    if (driveBreadcrumbs.length > 1 && driveCurrentFolderId !== driveRootFolderId) {
      handleDriveBreadcrumbClick(driveBreadcrumbs.length - 2);
    } else {
      setCurrentView('dashboard');
    }
  };

  const handleOpenDriveFile = (file) => {
    const subjectFolderId = driveBreadcrumbs[1]?.id;
    if (!subjectFolderId || !driveCurrentFolderId || driveBreadcrumbs.length !== 3) return;
    setDrivePreviewFile({
      ...file,
      contentUrl: getDriveFileContentUrl(driveCurrentFolderId, subjectFolderId, file.id),
      downloadUrl: getDriveFileContentUrl(driveCurrentFolderId, subjectFolderId, file.id, true)
    });
  };

  const handleToggleDrivePreviewFullscreen = async () => {
    try {
      if (document.fullscreenElement === drivePreviewContainerRef.current) {
        await document.exitFullscreen();
      } else {
        await drivePreviewContainerRef.current?.requestFullscreen();
      }
    } catch {
      setDriveNotesError('Full-screen preview is unavailable in this browser.');
    }
  };

  const handleFinalSubmitTest = async () => {
    if (submissionInProgressRef.current) return;
    submissionInProgressRef.current = true;
    submissionFailedRef.current = false;
    setIsSubmittingTest(true);
    setIsSubmitModalOpen(false);
    let didSubmit = false;

    try {
      const hasValidQuestionCount = ['revision-mock', 'exam-day'].includes(activeTestMode)
        ? [10, 20, 30, 40, 50, 60, 90, 120].includes(activeTestQuestions.length)
        : activeTestMode === 'bookmark-practice'
          ? activeTestQuestions.length >= 1 && activeTestQuestions.length <= 100
          : activeTestQuestions.length === 10;
      if (!hasValidQuestionCount) {
        setQuestionGenerationError('This test question set is incomplete and cannot be scored. Please generate a new test.');
        setCurrentView('topic-detail');
        return;
      }

      if (!activeAttemptId) throw new Error('This test session is no longer available. Generate a new test.');
      clearTimeout(answerSaveTimerRef.current);
      await answerSaveQueueRef.current;
      const activeQuestionIds = new Set(activeTestQuestions.map((question) => question.id).filter(Boolean));
      const answers = Object.entries(userAnswers)
        .filter(([questionId, answer]) => activeQuestionIds.has(questionId) && typeof answer === 'string')
        .map(([questionId, selectedAnswer]) => ({ questionId, selectedAnswer }));
      const { result } = await submitTestAttempt(activeAttemptId, answers);
      submissionFailedRef.current = false;
      answerSaveFailedRef.current = false;
      const attemptRecord = { ...result, id: result.attemptId };
      setCompletedAttempt(attemptRecord);
      setTestHistory((previousHistory) => [attemptRecord, ...previousHistory.filter((item) => item.attemptId !== result.attemptId)]);
      try {
        const { data } = await getCurrentCandidateData();
        const loadedHistory = (data.testHistory || []).map((attempt) => ({ ...attempt, id: attempt.id || attempt.attemptId }));
        setUserProgress(normalizeUserProgress(data.userProgress || {}, data.exam || selectedExam, loadedHistory, SUBJECT_TOPICS));
        setTestHistory(loadedHistory);
        setSavedQuestions(Array.isArray(data.savedQuestions) ? data.savedQuestions : []);
        plannerRevisionRef.current = Number(data.plannerRevision) || 0;
        setPlannerData(data.plannerData || createEmptyPlannerState(currentMember));
      } catch (error) {
        setAccountDataError(error.message || 'The result was saved, but refreshed progress could not be loaded. Retry from the dashboard.');
      }
      setActiveAttemptId(result.attemptId);
      setCurrentView('result');
      didSubmit = true;
    } catch (error) {
      submissionFailedRef.current = true;
      setAccountDataError(error.message || 'The test could not be submitted. Please retry.');
    } finally {
      if (!didSubmit) submissionInProgressRef.current = false;
      setIsSubmittingTest(false);
    }
  };

  const submitTestOnTimeout = useEffectEvent(handleFinalSubmitTest);

  // Countdown Timer Hook
  useEffect(() => {
    if (currentView !== 'test') return undefined;
    if (timeRemaining <= 0) {
      const submitTimeout = setTimeout(() => {
        void submitTestOnTimeout();
      }, 0);
      return () => clearTimeout(submitTimeout);
    }
    const timer = setTimeout(() => setTimeRemaining(timeRemaining - 1), 1000);
    return () => clearTimeout(timer);
  }, [currentView, timeRemaining]);

  const handleExplainWithAI = (q) => {
    const userAns = q.userAnswer || userAnswers[q.id] || 'Not answered';
    setAiModalContent('Asking the AI tutor to explain this evaluated answer...');
    void sendChatMessage({
      exam: normalizeExamForRequest(activeAttemptData?.exam || selectedExam),
      subject: q.subject || activeAttemptData?.subject || selectedSubject,
      topic: q.topic || activeAttemptData?.topic || selectedTopic,
      difficulty: activeAttemptData?.difficulty || activeTestDifficulty,
      messages: [{
        role: 'user',
        content: `Explain this evaluated exam answer. Question: ${q.question}. User answer: ${userAns}. Correct answer: ${q.correctAnswer}. Evaluated explanation: ${q.explanation}. Shortcut: ${q.shortcut}.`
      }]
    }).then(setAiModalContent).catch((error) => {
      setAiModalContent(getSafeAiMessage(error, 'The AI explanation is unavailable right now.'));
    });
  };

  const handleOpenMistakeChat = (questionId) => {
    if (reviewChatQuestionId === questionId) {
      setReviewChatQuestionId(null);
      return;
    }
    setReviewChatQuestionId(questionId);
    setReviewChatMessages([]);
    setReviewChatInput('');
  };

  const handleSendMistakeChat = async (question, userAnswer) => {
    const messageText = reviewChatInput.trim();
    if (!messageText || isReviewChatLoading) return;

    const context = `We are reviewing this incorrect exam answer. Question: ${question.question}. Candidate answer: ${userAnswer || 'Not answered'}. Correct answer: ${question.correctAnswer}. Existing explanation: ${question.explanation || 'No explanation provided.'}`;
    const userMessage = { sender: 'user', text: messageText };
    const nextMessages = [...reviewChatMessages, userMessage];
    setReviewChatMessages(nextMessages);
    setReviewChatInput('');
    setIsReviewChatLoading(true);

    try {
      const reply = await sendChatMessage({
        exam: normalizeExamForRequest(activeAttemptData?.exam || selectedExam),
        subject: question.subject || activeAttemptData?.subject || selectedSubject,
        topic: question.topic || activeAttemptData?.topic || selectedTopic,
        difficulty: activeTestDifficulty || 'Beginner', messages: [
          { role: 'user', content: context },
          ...nextMessages.map((message) => ({ role: message.sender === 'user' ? 'user' : 'assistant', content: message.text }))
        ]
      });
      setReviewChatMessages(prev => [...prev, { sender: 'ai', text: reply }]);
    } catch (error) {
      setReviewChatMessages(prev => [...prev, { sender: 'ai', text: getSafeAiMessage(error, 'I could not review this mistake right now. Please try again.') }]);
    } finally {
      setIsReviewChatLoading(false);
    }
  };

  const handleSendChatMessage = async () => {
    const messageText = chatInput.trim();
    if (!messageText || isChatLoading) return;
    const userMsg = { sender: 'user', text: chatInput };
    const nextMessages = [...chatMessages, userMsg];
    setChatMessages(nextMessages);
    setChatInput('');

    if (currentView === 'test') {
      setChatMessages(prev => [...prev, {
        sender: 'ai',
        text: 'Test protection is enabled. Submit your test first, then I can explain this concept.'
      }]);
      return;
    }

    setIsChatLoading(true);
    try {
      const reply = await sendChatMessage({
        exam: normalizeExamForRequest(selectedExam),
        subject: selectedSubject,
        topic: selectedTopic,
        difficulty: activeTestDifficulty || 'Beginner',
        syllabus: SUBJECT_TOPICS,
        messages: nextMessages.map((message) => ({ role: message.sender === 'user' ? 'user' : 'assistant', content: message.text }))
      });
      setChatMessages(prev => [...prev, { sender: 'ai', text: reply }]);
    } catch (error) {
      setChatMessages(prev => [...prev, { sender: 'ai', text: getSafeAiMessage(error, 'I could not answer that right now. Please try again.') }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const handleViewAttempt = (attempt) => {
    setCompletedAttempt(attempt);
    setActiveAttemptId(attempt.id);
    void handleChangeExam(attempt.exam || 'SI');
    setSelectedSubject(attempt.questions?.[0]?.subject || attempt.subject);
    setSelectedTopic(attempt.questions?.[0]?.topic || attempt.topic);
    setActiveTestDifficulty(attempt.difficulty || 'Beginner');
    setCurrentView('result');
  };

  const updatePlannerTask = (taskId, updates) => {
    plannerDirtyRef.current = true;
    setPlannerData((previous) => ({
      ...previous,
      schedule: (previous?.schedule || []).map((task) => task.id === taskId ? { ...task, ...updates, updatedAt: new Date().toISOString() } : task)
    }));
  };

  const deletePlannerTask = (taskId) => {
    plannerDirtyRef.current = true;
    setPlannerData((previous) => ({
      ...previous,
      schedule: (previous?.schedule || []).filter((task) => task.id !== taskId)
    }));
  };

  const handleAiScheduleTimeChange = (event) => {
    const dailyMinutes = Number(event.target.value);
    if (!Number.isInteger(dailyMinutes) || dailyMinutes < 30 || dailyMinutes > 720) return;
    setAiScheduleDailyMinutes(dailyMinutes);
    plannerDirtyRef.current = true;
    setPlannerData((previous) => ({ ...previous, aiScheduleDailyMinutes: dailyMinutes }));
  };

  const handleAddPlannerTask = (event) => {
    event.preventDefault();
    if (!currentMember) return;
    plannerDirtyRef.current = true;
    const nextTask = {
      id: `manual-${Date.now()}`,
      userId: currentMember.id,
      examType: selectedExam,
      date: plannerTaskForm.date,
      startTime: plannerTaskForm.startTime,
      endTime: plannerTaskForm.endTime,
      duration: Number(plannerTaskForm.duration) || 30,
      subject: plannerTaskForm.subject,
      topic: plannerTaskForm.topic,
      priority: plannerTaskForm.priority,
      reason: plannerTaskForm.notes || `Manual study task for ${plannerTaskForm.topic}.`,
      notes: plannerTaskForm.notes || '',
      status: plannerTaskForm.status || 'scheduled',
      autoGenerated: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    setPlannerData((previous) => ({
      ...previous,
      schedule: [...(previous?.schedule || []), nextTask].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
    }));
    setPlannerTaskForm({
      subject: selectedSubject || 'Arithmetic',
      topic: selectedTopic || 'Percentages',
      date: new Date().toISOString().split('T')[0],
      startTime: '19:00',
      endTime: '20:00',
      duration: 60,
      priority: 'MEDIUM',
      notes: '',
      status: 'scheduled'
    });
  };

  const handleRetryCandidateData = async () => {
    try {
      if (currentView === 'test' && activeAttemptId) {
        if (submissionFailedRef.current) {
          await handleFinalSubmitTest();
          return;
        }
        clearTimeout(answerSaveTimerRef.current);
        await answerSaveQueueRef.current;
        const activeQuestionIds = new Set(activeTestQuestions.map((question) => question.id).filter(Boolean));
        const answers = Object.fromEntries(Object.entries(userAnswers).filter(([questionId]) => activeQuestionIds.has(questionId)));
        await saveTestAnswers(activeAttemptId, answers);
        answerSaveFailedRef.current = false;
        setAccountDataError('');
        return;
      }
      if (currentMember) {
        const saved = await saveCurrentCandidatePlanner(plannerViewData, plannerRevisionRef.current);
        plannerRevisionRef.current = Number(saved.plannerRevision) || plannerRevisionRef.current + 1;
      }
      const sessionUser = currentMember ? null : (await getCurrentCandidate()).user;
      const { data } = await getCurrentCandidateData();
      if (!currentMember) {
        loadMember(sessionUser, data);
        return;
      }
      plannerRevisionRef.current = Number(data.plannerRevision) || 0;
      plannerSaveFailedRef.current = false;
      const loadedHistory = (data.testHistory || []).map((attempt) => ({ ...attempt, id: attempt.id || attempt.attemptId }));
      setUserProgress(normalizeUserProgress(data.userProgress || {}, data.exam || selectedExam, loadedHistory, SUBJECT_TOPICS));
      setTestHistory(loadedHistory);
      setTestAttemptCounter(Number(data.testAttemptCounter) || 0);
      setPlannerData(data.plannerData || createEmptyPlannerState(currentMember));
      setAccountDataError('');
    } catch (error) {
      setAccountDataError(error.message || 'Unable to connect to the server. Please try again.');
    }
  };

  const selectedExamHistory = getExamHistory(testHistory, selectedExam);
  const selectedExamProgress = Object.values(userProgress).filter((progress) => progress?.exam === selectedExam && Number(progress.attempts || 0) > 0);
  const selectedExamQuestionCount = selectedExamHistory.reduce((total, attempt) => total + Number(attempt.total || 0), 0);
  const bestExamAttempt = selectedExamHistory.reduce((best, attempt) => {
    const attemptTotal = Number(attempt.total) || 10;
    const bestTotal = Number(best?.total) || 10;
    return !best || (Number(attempt.score) || 0) / attemptTotal > (Number(best.score) || 0) / bestTotal ? attempt : best;
  }, null);
  const mistakeNotebook = useMemo(() => getMistakeNotebook(selectedExamHistory, selectedExam), [selectedExamHistory, selectedExam]);
  const spacedRevisionRecommendations = useMemo(
    () => getSpacedRevisionRecommendations(userProgress, selectedExamHistory, selectedExam, SUBJECT_TOPICS, new Date(countdownNow)),
    [userProgress, selectedExamHistory, selectedExam, countdownNow]
  );
  const mockTestInsights = useMemo(() => getMockTestInsights(selectedExamHistory, selectedExam), [selectedExamHistory, selectedExam]);
  const selectedExamBookmarks = savedQuestions.filter((question) => question.exam === selectedExam);

  const handleToggleBookmark = async (question, attempt = activeAttemptData) => {
    const id = String(question?.questionId || question?.id || '');
    if (!id || isSavingBookmarks) return;
    const isSaved = savedQuestions.some((item) => item.id === id);
    let nextBookmarks;
    if (isSaved) {
      nextBookmarks = savedQuestions.filter((item) => item.id !== id);
      setSelectedBookmarkIds((previous) => previous.filter((selectedId) => selectedId !== id));
    } else {
      const bookmark = {
        id,
        exam: attempt?.exam || selectedExam,
        subject: question.subject || attempt?.subject || selectedSubject,
        topic: question.topic || attempt?.topic || selectedTopic,
        difficulty: question.difficulty || attempt?.difficulty || activeTestDifficulty,
        question: question.question,
        options: question.options,
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
        shortcut: question.shortcut,
        questionType: question.questionType
      };
      nextBookmarks = [...savedQuestions, bookmark];
    }
    setIsSavingBookmarks(true);
    try {
      const response = await saveCurrentCandidateBookmarks(nextBookmarks);
      setSavedQuestions(response.savedQuestions);
      setAccountDataError('');
    } catch (error) {
      setAccountDataError(error.message || 'The saved-question list could not be updated. Please retry.');
    } finally {
      setIsSavingBookmarks(false);
    }
  };

  const handleStartBookmarkedPractice = async () => {
    if (!selectedBookmarkIds.length || isGeneratingQuestions) return;
    initializeExamAudio(examAudioContextRef);
    halfTimeAlertPlayedRef.current = false;
    finalMinuteAlertsPlayedRef.current.clear();
    setShowExamFocusWarning(false);
    setIsGeneratingQuestions(true);
    setQuestionGenerationError('');
    setQuestionGenerationNotice('Loading your saved practice questions...');
    setCompletedAttempt(null);
    submissionInProgressRef.current = false;
    setIsSubmittingTest(false);
    try {
      const { attempt } = await createBookmarkedTestAttempt({
        questionIds: selectedBookmarkIds,
        durationMinutes: bookmarkPracticeDuration
      });
      if (!attempt?.attemptId || attempt.mode !== 'bookmark-practice'
        || !Array.isArray(attempt.questions) || attempt.questions.length !== selectedBookmarkIds.length) {
        throw new Error('The server returned an invalid saved-question set.');
      }
      setActiveAttemptId(attempt.attemptId);
      setActiveTestQuestions(attempt.questions);
      setActiveTestMode('bookmark-practice');
      setActiveTestDurationSeconds(bookmarkPracticeDuration * 60);
      setUserAnswers({});
      setCurrentQuestionIdx(0);
      setTimeRemaining(bookmarkPracticeDuration * 60);
      setSelectedBookmarkIds([]);
      setActiveTestDifficulty('Mixed');
      setCurrentView('test');
    } catch (error) {
      setAccountDataError(error.message || 'Could not start saved-question practice. Please try again.');
    } finally {
      setIsGeneratingQuestions(false);
    }
  };

  const handlePracticeTopic = (subject, topic) => {
    const matchingSubjects = Object.keys(SUBJECT_TOPICS)
      .filter((candidate) => SUBJECT_TOPICS[candidate]?.includes(topic));
    const resolvedSubject = matchingSubjects.includes(subject)
      ? subject
      : matchingSubjects.length === 1 ? matchingSubjects[0] : '';
    if (!resolvedSubject) {
      setQuestionGenerationError(matchingSubjects.length > 1
        ? 'This topic is listed under multiple subjects. Choose the correct subject above, then select the topic to continue.'
        : 'This topic could not be found in the syllabus. Choose a subject above and select an available topic.');
      setCurrentView('topics');
      return;
    }

    setSelectedSubject(resolvedSubject);
    setSelectedTopic(topic);
    setQuestionGenerationError('');
    setLearningVideos([]);
    setLearningVideosError('');
    setIsLoadingLearningVideos(true);
    setStudyNotes(null);
    setSelectedNotesLearningStage('');
    setStudyNotesError('');
    setShowStudyNotes(false);
    setNotesDoubtMessages([]);
    setNotesDoubtInput('');
    setNotesDoubtError('');
    setCurrentView('topic-detail');
  };

  const handleExplainInTelugu = (question) => {
    const userAnswer = question.userAnswer || 'Not answered';
    setAiModalContent('Preparing a Telugu explanation...');
    void sendChatMessage({
      exam: normalizeExamForRequest(activeAttemptData?.exam || selectedExam),
      subject: question.subject || activeAttemptData?.subject || selectedSubject,
      topic: question.topic || activeAttemptData?.topic || selectedTopic,
      difficulty: activeAttemptData?.difficulty || activeTestDifficulty,
      messages: [{
        role: 'user',
        content: `Explain this exam question and answer in clear Telugu. Keep formulas and answer choices unchanged where helpful. Question: ${question.question}. Candidate answer: ${userAnswer}. Correct answer: ${question.correctAnswer}. Explanation: ${question.explanation || ''}.`
      }]
    }).then(setAiModalContent).catch((error) => {
      setAiModalContent(getSafeAiMessage(error, 'The Telugu explanation is unavailable right now.'));
    });
  };

  const downloadProgressReport = (format) => {
    const contents = format === 'csv'
      ? createProgressCsv({
        profile: currentMember,
        exam: selectedExam,
        history: testHistory,
        progress: userProgress,
        recommendations: spacedRevisionRecommendations
      })
      : JSON.stringify({
        generatedAt: new Date().toISOString(),
        profile: { name: currentMember.name, email: currentMember.email },
        exam: selectedExam,
        userProgress: Object.values(userProgress).filter((item) => item?.exam === selectedExam),
        testHistory: selectedExamHistory,
        plannerTasks: selectedPlannerTasks,
        spacedRevisionRecommendations
      }, null, 2);
    const mimeType = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
    const extension = format === 'csv' ? 'csv' : 'json';
    const fileUrl = URL.createObjectURL(new Blob([contents], { type: mimeType }));
    const link = document.createElement('a');
    link.href = fileUrl;
    link.download = `ts-police-${selectedExam.toLowerCase()}-progress.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
  };
  const activeAttemptData = completedAttempt || selectedExamHistory.find((item) => item.id === activeAttemptId) || selectedExamHistory[0] || null;
  const activeQuestionIds = new Set(activeTestQuestions.map((question) => question.id).filter(Boolean));
  const activeAnswerCount = Object.entries(userAnswers).filter(([questionId, answer]) => activeQuestionIds.has(questionId) && Boolean(answer)).length;

  const subjectPerformance = useMemo(() => {
    const subjectLabels = {
      Arithmetic: 'Arithmetic',
      Reasoning: 'Reasoning',
      'General Studies': 'Gen Studies',
      'Telangana GK': 'Telangana GK',
      English: 'English'
    };

    return Object.entries(subjectLabels).map(([subject, label]) => {
      const attempts = selectedExamHistory.filter((attempt) => attempt.subject === subject);
      const accuracy = attempts.length
        ? Math.round(attempts.reduce((total, attempt) => total + (attempt.accuracy || 0), 0) / attempts.length)
        : 0;
      return { subject: label, accuracy };
    });
  }, [selectedExamHistory]);

  const subjectProgressSummary = useMemo(() => {
    return Object.keys(SUBJECT_TOPICS).map((subject) => {
      const attempts = selectedExamHistory.filter((attempt) => attempt.subject === subject);
      const accuracy = attempts.length
        ? Math.round(attempts.reduce((total, attempt) => total + (attempt.accuracy || 0), 0) / attempts.length)
        : 0;
      const completion = calculateSubjectCompletion(subject, SUBJECT_TOPICS[subject], userProgress, selectedExamHistory, selectedExam);
      const status = getProgressStatus(completion);
      return {
        subject,
        accuracy,
        completion,
        status,
        colorClass: getStatusColorClass(status)
      };
    });
  }, [selectedExamHistory, selectedExam, userProgress]);

  const currentTopicProgress = getTopicProgress(userProgress, selectedExam, selectedSubject, selectedTopic) || { level: 'Beginner', bestScore: 0, attempts: 0 };
  const currentLearningLevel = selectedNotesLearningStage || currentTopicProgress.level || activeTestDifficulty || 'Beginner';
  const currentLearningStageIndex = LEARNING_LEVEL_INDEX[currentLearningLevel] ?? 0;
  const visibleStudyNoteSections = studyNotes
    ? NOTE_SECTION_PRESENTATION
      .map((section) => ({ ...section, items: Array.isArray(studyNotes[section.key]) ? studyNotes[section.key].filter(Boolean) : [] }))
      .filter((section) => section.items.length > 0)
    : [];
  const selectedLegacyMember = legacyMembers.find((member) => member.id === selectedLegacyMemberId) || null;
  const legacyImportPanel = legacyMembers.length > 0 ? (
    <section aria-labelledby="legacy-import-heading" className="mt-6 border-t border-amber-500/30 pt-5">
      <h3 id="legacy-import-heading" className="text-sm font-bold text-amber-200">Import an older browser account</h3>
      <p className="mt-2 text-xs leading-5 text-slate-400">This browser still has saved account data. Choose one account and verify it with its old password. Its history and progress will be archived as unverified, separate from new practice statistics. The browser copy is removed only after import and account reload succeed.</p>
      {currentMember && <p className="mt-2 text-xs text-slate-300">Signed in as {currentMember.email}. The selected legacy email must match this account.</p>}
      <form onSubmit={handleLegacyImport} className="mt-4 space-y-3">
        {legacyMembers.length > 1 ? (
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-300">Saved account</span>
            <select value={selectedLegacyMemberId} onChange={(event) => { setSelectedLegacyMemberId(event.target.value); setLegacyImportError(''); }} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-white outline-none focus:border-amber-500">
              {legacyMembers.map((member) => <option key={member.id} value={member.id}>{member.name || 'Candidate'} · {member.email}</option>)}
            </select>
          </label>
        ) : selectedLegacyMember ? (
          <p className="text-xs text-slate-300">{selectedLegacyMember.name || 'Candidate'} · {selectedLegacyMember.email}</p>
        ) : null}
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-slate-300">Old account password</span>
          <input type="password" autoComplete="current-password" value={legacyImportPassword} onChange={(event) => setLegacyImportPassword(event.target.value)} required maxLength={128} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-white outline-none focus:border-amber-500" placeholder="Password used with the older account" />
        </label>
        {legacyImportError && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">{legacyImportError}</p>}
        <button type="submit" disabled={isLegacyImporting || !selectedLegacyMember} className="w-full rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm font-bold text-amber-100 transition hover:bg-amber-500/20 disabled:opacity-60">
          {isLegacyImporting ? 'Verifying and importing...' : 'Import selected account'}
        </button>
      </form>
    </section>
  ) : null;

  if (!isMemberHydrated) {
    return <main role="status" className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-300">Checking your account...</main>;
  }

  if (!currentMember) {
    const isSignup = currentView === 'signup';
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-5xl min-h-[620px] grid md:grid-cols-[1.05fr_0.95fr] overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
          <section className="relative hidden md:flex flex-col justify-between overflow-hidden bg-gradient-to-br from-teal-950 via-slate-900 to-slate-950 p-10">
            <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'radial-gradient(circle at 75% 20%, #0f766e 0, transparent 42%), linear-gradient(135deg, transparent 60%, #1e3a5f 100%)' }} />
            <div className="relative flex items-center gap-3">
              <div className="rounded-lg bg-teal-500/15 p-2.5 text-teal-300"><ShieldAlert className="h-6 w-6" /></div>
              <div>
                <p className="font-bold text-white">TS Police AI Prep</p>
                <p className="text-xs text-slate-400">SI & Constable Practice Portal</p>
              </div>
            </div>
            <div className="relative max-w-md">
              <p className="mb-4 text-xs font-bold uppercase tracking-wider text-teal-300">Your preparation, in one place</p>
              <h1 className="text-4xl font-bold leading-tight text-white">Build a steadier path to exam day.</h1>
              <p className="mt-4 text-sm leading-6 text-slate-300">Practice topic by topic, track your progress, and get fresh AI-generated question sets.</p>
            </div>
            <p className="relative text-xs text-slate-500">Your account and progress sync securely across your devices.</p>
          </section>

          <section className="flex items-center justify-center p-6 sm:p-10">
            <div className="w-full max-w-sm">
              <div className="mb-8 md:hidden flex items-center gap-3">
                <div className="rounded-lg bg-teal-500/15 p-2.5 text-teal-300"><ShieldAlert className="h-6 w-6" /></div>
                <div><p className="font-bold text-white">TS Police AI Prep</p><p className="text-xs text-slate-400">SI & Constable Practice Portal</p></div>
              </div>
              <div className="mb-7">
                <p className="text-xs font-bold uppercase tracking-wider text-teal-300">Member access</p>
                <h2 className="mt-2 text-3xl font-bold text-white">{isSignup ? 'Create your account' : 'Welcome back'}</h2>
                <p className="mt-2 text-sm text-slate-400">{isSignup ? 'Save your practice history and continue anytime.' : 'Sign in to continue your exam preparation.'}</p>
              </div>

              <div className="mb-6 grid grid-cols-2 rounded-lg border border-slate-700 bg-slate-950 p-1">
                <button type="button" onClick={() => { setCurrentView('login'); setAuthError(''); setAuthSuccess(''); }} className={`rounded-md py-2 text-sm font-semibold transition ${!isSignup ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>Log in</button>
                <button type="button" onClick={() => { setCurrentView('signup'); setAuthError(''); setAuthSuccess(''); }} className={`rounded-md py-2 text-sm font-semibold transition ${isSignup ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>Sign up</button>
              </div>

              <form onSubmit={handleAuthSubmit} className="space-y-4">
                {isSignup && (
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold text-slate-300">Full name</span>
                    <input autoComplete="name" value={authName} onChange={(event) => setAuthName(event.target.value)} required className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-3 text-sm text-white outline-none transition focus:border-teal-500" placeholder="Your name" />
                  </label>
                )}
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-300">Email address</span>
                  <span className="relative block"><Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required className="w-full rounded-lg border border-slate-700 bg-slate-950 py-3 pl-10 pr-3.5 text-sm text-white outline-none transition focus:border-teal-500" placeholder="you@example.com" /></span>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-300">Password</span>
                  <span className="relative block"><KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input type="password" autoComplete={isSignup ? 'new-password' : 'current-password'} minLength={isSignup ? 8 : undefined} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required className="w-full rounded-lg border border-slate-700 bg-slate-950 py-3 pl-10 pr-3.5 text-sm text-white outline-none transition focus:border-teal-500" placeholder={isSignup ? 'At least 8 characters' : 'Your password'} /></span>
                </label>
                {authSuccess && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-200">{authSuccess}</p>}
                {(authError || accountDataError) && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">{authError || accountDataError}</p>}
                {accountDataError && <button type="button" onClick={() => { void handleRetryCandidateData(); }} className="w-full rounded-md border border-amber-500/40 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/10">Retry loading saved account data</button>}
                <button type="submit" disabled={isAuthenticating} className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-teal-500 disabled:opacity-60">
                  {isSignup ? <UserPlus className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                  {isAuthenticating ? 'Please wait...' : isSignup ? 'Create account' : 'Log in'}
                </button>
              </form>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <div data-high-contrast={highContrast} className="min-h-screen w-full min-w-0 max-w-full bg-slate-900 text-slate-100 flex flex-col font-sans">
      {legacyArchive && <div className="mx-auto mt-3 w-full max-w-5xl border-y border-amber-500/30 bg-amber-950/20 px-4 py-3 text-xs text-amber-100">
        <p>Older account data is archived separately and marked unverified. It is not included in current practice statistics. Archived history: {legacyArchive.testHistory?.length || 0} tests; progress topics: {Object.keys(legacyArchive.userProgress || {}).length}.</p>
        {legacyArchive.plannerData && (legacyArchive.plannerData.schedule?.length > 0 || legacyArchive.plannerData.topicMetrics?.length > 0) && (
          <details className="mt-2">
            <summary className="cursor-pointer font-semibold">View archived planner ({legacyArchive.plannerData.schedule?.length || 0} tasks)</summary>
            <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
              {(legacyArchive.plannerData.schedule || []).slice(0, 100).map((task) => <p key={task.id} className="text-slate-200">{task.date} · {task.subject} · {task.topic} · {task.reason || task.notes || 'Legacy task'} · Unverified</p>)}
            </div>
          </details>
        )}
      </div>}
      {/* Top Navigation Bar */}
      <header className="bg-slate-800 border-b border-slate-700 sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex min-w-0 items-center space-x-2 sm:space-x-3">
          <div className="bg-gradient-to-tr from-blue-600 to-indigo-500 p-2 rounded-lg text-white shadow-lg">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-extrabold text-lg tracking-tight bg-gradient-to-r from-blue-400 to-teal-300 bg-clip-text text-transparent">
              TS Police AI Prep
            </h1>
            <p className="text-xs text-slate-400">SI & Constable Infinite Practice Portal</p>
          </div>
        </div>

        {/* Global Exam Toggle */}
        <div className="order-last flex w-full items-center justify-center space-x-2 rounded-xl border border-slate-700 bg-slate-900/80 p-1 sm:order-none sm:w-auto">
          <button
            onClick={() => { void handleChangeExam('SI'); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${selectedExam === 'SI' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
          >
            TS SI
          </button>
          <button
            onClick={() => { void handleChangeExam('CONSTABLE'); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${selectedExam === 'CONSTABLE' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
          >
            TS Constable
          </button>
        </div>

        {/* Top Header Actions */}
        <div className="ml-auto flex shrink-0 items-center space-x-2">
          {currentView === 'test' && activeTestQuestions.length > 0 && (
            <div
              role="timer"
              aria-label={`Time remaining ${Math.floor(timeRemaining / 60)} minutes ${timeRemaining % 60} seconds`}
              className={`flex min-w-[5.5rem] items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 font-mono text-sm font-bold tabular-nums shadow-inner ${timeRemaining <= 60 ? 'border-rose-500/50 bg-rose-500/10 text-rose-300' : 'border-amber-500/30 bg-slate-900 text-amber-400'}`}
            >
              <Clock className="h-4 w-4" />
              <span>
                {Math.floor(timeRemaining / 60).toString().padStart(2, '0')}:
                {(timeRemaining % 60).toString().padStart(2, '0')}
              </span>
            </div>
          )}
          <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 bg-slate-900/70 border border-slate-700 rounded-lg">
            <div className="w-6 h-6 rounded-full bg-teal-500/20 text-teal-300 flex items-center justify-center text-[10px] font-black">
              {currentMember.name.slice(0, 2).toUpperCase()}
            </div>
            <span className="text-xs font-semibold text-slate-200 max-w-28 truncate">{currentMember.name}</span>
          </div>
          <button
            onClick={() => setShowDevModal(true)}
            className="flex items-center space-x-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded-lg font-medium transition"
          >
            <Code className="w-4 h-4 text-emerald-400" />
            <span className="hidden sm:inline">Engine Specs</span>
          </button>
          <button
            onClick={() => setCurrentView('ai-tutor')}
            className="flex items-center space-x-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg font-bold shadow transition"
          >
            <Sparkles className="w-4 h-4 text-amber-300" />
            <span className="hidden sm:inline">AI Tutor</span>
          </button>
          <button
            onClick={handleLogout}
            title="Log out"
            className="p-2 bg-slate-700 hover:bg-red-500/20 text-slate-300 hover:text-red-300 rounded-lg transition"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main App Layout */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Navigation Sidebar */}
        <nav className="bg-slate-800/60 border-r border-slate-800 w-full md:w-64 p-4 flex md:flex-col justify-between overflow-x-auto md:overflow-y-auto shrink-0">
          <div className="space-y-1 w-full flex md:flex-col space-x-2 md:space-x-0">
            <button
              onClick={() => setCurrentView('dashboard')}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${currentView === 'dashboard' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
            >
              <BarChart2 className="w-4 h-4" />
              <span>Dashboard</span>
            </button>
            <button
              onClick={() => setCurrentView('planner')}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${currentView === 'planner' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
            >
              <CalendarDays className="w-4 h-4 text-emerald-400" />
              <span>Smart Study Planner</span>
            </button>
            <button
              onClick={() => { setShowFullAiSchedule(false); setCurrentView('ai-schedule'); }}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${currentView === 'ai-schedule' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
            >
              <Sparkles className="w-4 h-4 text-amber-300" />
              <span>AI Study Schedule</span>
            </button>
            <button
              onClick={() => setCurrentView('topics')}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${currentView === 'topics' || currentView === 'topic-detail' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
            >
              <BookOpen className="w-4 h-4" />
              <span>Syllabus & Tests</span>
            </button>
            <button
              onClick={handleOpenDriveLibrary}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${currentView === 'drive-notes' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
            >
              <BookOpen className="w-4 h-4 text-teal-400" />
              <span>Notes Library</span>
            </button>
            <button
              onClick={() => setCurrentView('ai-tutor')}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${currentView === 'ai-tutor' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
            >
              <Brain className="w-4 h-4 text-indigo-400" />
              <span>AI Exam Guru</span>
            </button>
            <button
              onClick={() => setCurrentView('profile')}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${currentView === 'profile' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
            >
              <User className="w-4 h-4" />
              <span>Profile & History</span>
            </button>
          </div>

          <div className="hidden md:block p-3 bg-slate-900/80 rounded-xl border border-slate-700/50 mt-6 space-y-2">
            <div className="flex items-center space-x-2 text-xs font-semibold text-slate-300">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              <span>AI Question Engine</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-tight">
              Every test is generated dynamically by Gemini AI for the selected exam, subject, topic, and level.
            </p>
          </div>
        </nav>

        {/* Content View Router */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 bg-slate-900">
          {accountDataError && (
            <div role="alert" className="mx-auto mb-4 flex max-w-6xl flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              <span>{accountDataError}</span>
              <button type="button" onClick={() => { void handleRetryCandidateData(); }} className="rounded-md border border-amber-400/40 px-3 py-1.5 text-xs font-semibold hover:bg-amber-400/10">Retry</button>
            </div>
          )}
          {/* DASHBOARD VIEW */}
          {currentView === 'dashboard' && (
            <div className="max-w-6xl mx-auto space-y-6">
              <div className="bg-gradient-to-r from-blue-900/40 via-indigo-900/30 to-slate-800 border border-blue-500/20 rounded-2xl p-6 shadow-xl relative overflow-hidden">
                <div className="relative z-10">
                  <div className="inline-flex items-center space-x-2 px-3 py-1 bg-emerald-500/10 border border-emerald-500/30 rounded-full text-emerald-400 text-xs font-semibold mb-3">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Gemini AI Question System: Active</span>
                  </div>
                  <h2 className="text-2xl md:text-3xl font-bold text-white">Welcome, {currentMember.name}!</h2>
                  <p className="text-slate-300 text-sm mt-1 max-w-2xl">
                    Targeting <span className="text-blue-400 font-bold">Telangana {selectedExam}</span>. Your progress and test history are saved to your account.
                  </p>
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium">Tests Attempted</p>
                  <p className="text-2xl font-black text-white mt-1">{selectedExamHistory.length}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium">Unique Questions Attempted</p>
                  <p className="text-2xl font-black text-emerald-400 mt-1">{selectedExamQuestionCount}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium">Attempt Seed Version</p>
                  <p className="text-2xl font-black text-blue-400 mt-1">v{testAttemptCounter}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium">Unlocked Topics</p>
                  <p className="text-2xl font-black text-amber-400 mt-1">
                    {new Set(selectedExamProgress.map((progress) => progress.topic)).size} / {TOTAL_TOPICS}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_0.7fr] gap-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-300">Smart Preparation</p>
                      <h3 className="mt-2 text-xl font-bold text-white">Overall Progress {plannerViewData?.summary?.overallProgress ?? 0}%</h3>
                    </div>
                    <button onClick={() => setCurrentView('planner')} className="rounded-lg border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200 hover:bg-teal-500/20">View Full Planner</button>
                  </div>
                  <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-[11px] text-slate-400">Syllabus Completed</p>
                      <p className="mt-2 text-xl font-black text-white">{plannerViewData?.summary?.syllabusCompletion ?? 0}%</p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-[11px] text-slate-400">Tests Attempted</p>
                      <p className="mt-2 text-xl font-black text-white">{plannerViewData?.summary?.testsAttempted ?? selectedExamHistory.length}</p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-[11px] text-slate-400">Average Accuracy</p>
                      <p className="mt-2 text-xl font-black text-emerald-300">{plannerViewData?.summary?.averageAccuracy ?? 0}%</p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-[11px] text-slate-400">Days Remaining</p>
                      <p className="mt-2 text-xl font-black text-blue-300">{plannerViewData?.summary?.daysRemaining ?? 0}</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-300">Today&apos;s Plan</p>
                  <div className="mt-4 space-y-3">
                    {selectedPlannerTasks.filter((task) => task.date === new Date().toISOString().split('T')[0]).slice(0, 3).map((task) => (
                      <div key={task.id} className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-bold text-white">{task.subject}</p>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${getPriorityColorClass(task.priority)}`}>{task.priority}</span>
                        </div>
                        <p className="mt-1 text-xs text-slate-300">{task.topic}</p>
                        <p className="mt-1 text-[11px] text-slate-400">{task.startTime} - {task.endTime} · {task.duration} min</p>
                      </div>
                    )) || <p className="text-sm text-slate-400">No tasks planned yet.</p>}
                  </div>
                </div>
              </div>

              {spacedRevisionRecommendations.length > 0 && (
                <section aria-label="Topics due for spaced revision" className="rounded-2xl border border-amber-500/20 bg-gradient-to-r from-amber-950/30 to-slate-800/80 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-300">Spaced revision</p>
                      <h3 className="mt-1 text-lg font-bold text-white">Topics to revisit</h3>
                    </div>
                    <button type="button" onClick={() => setCurrentView('profile')} className="rounded-lg border border-amber-400/30 px-3 py-2 text-xs font-bold text-amber-100 hover:bg-amber-500/10">View revision plan</button>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
                    {spacedRevisionRecommendations.slice(0, 3).map((item) => (
                      <button key={`${item.subject}:${item.topic}`} type="button" onClick={() => handlePracticeTopic(item.subject, item.topic)} className="rounded-xl border border-slate-700 bg-slate-900/70 p-3 text-left hover:border-amber-400/40">
                        <span className="block text-xs font-bold text-slate-100">{item.subject} · {item.topic}</span>
                        <span className="mt-1 block text-[11px] text-amber-200">{item.daysUntilDue <= 0 ? 'Due now' : `Due in ${item.daysUntilDue} days`} · {item.accuracy}% recent accuracy</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section aria-label="Upcoming exam countdown" className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-slate-100">Exam Countdown</h3>
                    <p className="mt-1 text-xs text-slate-500">Counting to 00:00 IST on each exam date</p>
                  </div>
                  <Clock className="h-5 w-5 text-teal-300" />
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {UPCOMING_EXAMS.map((exam) => {
                    const countdown = getExamCountdown(exam.targetTime, countdownNow);
                    return (
                      <article key={exam.id} className="rounded-lg border border-slate-700 bg-slate-800/80 p-4 sm:p-5">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <h4 className="text-sm font-bold text-white">{exam.name}</h4>
                            <p className="mt-1 text-xs text-slate-400">{exam.weekday} · {exam.date} · IST</p>
                          </div>
                          {countdown.isPast ? (
                            <span className="shrink-0 text-sm font-semibold text-slate-400">Exam date passed</span>
                          ) : (
                            <div className="grid grid-cols-3 gap-2 sm:min-w-64">
                              {[
                                ['Days', countdown.days],
                                ['Hours', countdown.hours],
                                ['Minutes', countdown.minutes]
                              ].map(([unit, value]) => (
                                <div key={unit} className="min-w-0 rounded-md bg-slate-900 px-2 py-2 text-center">
                                  <p className="font-mono text-xl font-bold tabular-nums text-teal-200">{String(value).padStart(2, '0')}</p>
                                  <p className="mt-0.5 text-[10px] uppercase text-slate-500">{unit}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              {/* Subject Cards */}
              <div>
                <h3 className="text-lg font-bold text-slate-100 mb-3 flex items-center space-x-2">
                  <Target className="w-5 h-5 text-blue-400" />
                  <span>Syllabus Modules</span>
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <button
                    type="button"
                    onClick={() => { setQuestionGenerationError(''); setQuestionGenerationNotice(''); setCurrentView('revision-mock'); }}
                    className="rounded-xl border border-teal-500/30 bg-gradient-to-br from-teal-950/70 to-slate-800 p-4 text-left shadow-md transition hover:border-teal-400"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-white">All · Revision Mock Tests</span>
                      <ChevronRight className="h-4 w-4 text-teal-300" />
                    </div>
                    <p className="mt-2 text-xs text-slate-300">Timed mixed-subject practice sampled from the topics you have already practiced.</p>
                    <p className="mt-3 text-[11px] font-semibold text-teal-200">{selectedExamProgress.length} practiced topics available</p>
                  </button>
                  {Object.keys(SUBJECT_TOPICS).map((subj) => {
                    const subjectMetric = subjectProgressSummary.find((item) => item.subject === subj) || {
                      accuracy: 0,
                      completion: 0,
                      status: 'Not started',
                      colorClass: getStatusColorClass('Not started')
                    };

                    return (
                      <div
                        key={subj}
                        onClick={() => { setSelectedSubject(subj); setSelectedTopic(SUBJECT_TOPICS[subj]?.[0] || ''); setCurrentView('topics'); }}
                        className={`rounded-xl border p-4 shadow-md transition cursor-pointer group ${subjectMetric.colorClass} hover:border-blue-500`}
                      >
                        <div className="flex justify-between items-center mb-2">
                          <span className="font-bold text-slate-100 group-hover:text-blue-400 transition">{subj}</span>
                          <ChevronRight className="w-4 h-4 text-slate-400 group-hover:translate-x-1 transition" />
                        </div>
                        <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-slate-900/60">
                          <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-yellow-400 to-orange-500" style={{ width: `${subjectMetric.completion}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-200">
                          <span>{subjectMetric.completion}% complete</span>
                          <span>{subjectMetric.accuracy}% accuracy</span>
                        </div>
                        <p className="mt-2 text-xs text-slate-300">
                          {SUBJECT_TOPICS[subj].length} Core Topics • AI-Generated Tests
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Accuracy Chart */}
              <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-5 shadow-lg">
                <h3 className="text-md font-bold text-slate-200 mb-4 flex items-center space-x-2">
                  <BarChart2 className="w-4 h-4 text-teal-400" />
                  <span>Subject Performance Accuracy</span>
                </h3>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={subjectPerformance}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="subject" stroke="#94a3b8" fontSize={12} />
                      <YAxis stroke="#94a3b8" fontSize={12} domain={[0, 100]} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', borderRadius: '8px' }} />
                      <Bar dataKey="accuracy" fill="#3b82f6" radius={[6, 6, 0, 0]}>
                        {[0, 1, 2, 3, 4].map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={index === 3 ? '#10b981' : '#3b82f6'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {currentView === 'ai-schedule' && (
            <div className="mx-auto max-w-6xl space-y-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-300">Personalized with AI</p>
                  <h2 className="mt-2 text-3xl font-bold text-white">{selectedExam === 'CONSTABLE' ? 'TS Constable' : 'TS SI'} study schedule</h2>
                  <p className="mt-2 max-w-2xl text-sm text-slate-400">The AI reprioritizes the full syllabus using your practice, accuracy, topic completion, exam weightage, and time remaining. It refreshes when your progress or study time changes.</p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs font-semibold text-slate-300">
                    Available study time per day
                    <select
                      aria-label="Available study time per day"
                      value={aiScheduleDailyMinutes}
                      onChange={handleAiScheduleTimeChange}
                      className="mt-1 block rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                    >
                      {Array.from({ length: 16 }, (_, index) => (index + 1) * 30).map((minutes) => (
                        <option key={minutes} value={minutes}>{minutes / 60} {minutes === 30 ? 'hour' : 'hours'}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => setAiScheduleRefreshToken((token) => token + 1)}
                    disabled={isAiScheduleLoading}
                    className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60"
                  >
                    <RefreshCw className={`h-4 w-4 ${isAiScheduleLoading ? 'animate-spin' : ''}`} />
                    {isAiScheduleLoading ? 'Updating schedule…' : 'Regenerate schedule'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                {[
                  { label: 'Days to exam', value: aiScheduleInput.daysRemaining },
                  { label: 'Syllabus coverage', value: `${aiStudySchedule?.coverageCount || 0} / ${aiStudySchedule?.totalTopics || aiScheduleInput.topicMetrics.length}` },
                  { label: 'Topics needing focus', value: aiScheduleInput.topicMetrics.filter((metric) => metric.completion < 75 || metric.accuracy < 75).length },
                  { label: 'Your average accuracy', value: `${plannerViewData?.summary?.averageAccuracy || 0}%` }
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border border-slate-700 bg-slate-800/80 p-4">
                    <p className="text-[11px] uppercase tracking-[0.15em] text-slate-400">{item.label}</p>
                    <p className="mt-2 text-2xl font-black text-white">{item.value}</p>
                  </div>
                ))}
              </div>

              {aiScheduleError && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                  <span>{aiScheduleError}</span>
                  <button type="button" onClick={() => setAiScheduleRefreshToken((token) => token + 1)} className="rounded-md border border-rose-300/40 px-3 py-1.5 text-xs font-bold hover:bg-rose-500/10">Retry AI schedule</button>
                </div>
              )}

              {isAiScheduleLoading && (
                <div role="status" className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-5 text-sm text-indigo-100">
                  <Sparkles className="mr-2 inline h-4 w-4 animate-pulse" />
                  Reviewing your progress and exam weightage to build a complete, personalized topic plan…
                </div>
              )}

              {aiStudySchedule && (
                <>
                  {aiStudySchedule.strategy && (
                    <section className="rounded-2xl border border-indigo-500/30 bg-indigo-500/10 p-5">
                      <h3 className="flex items-center gap-2 font-bold text-indigo-100"><Sparkles className="h-4 w-4 text-amber-300" /> AI study strategy</h3>
                      <p className="mt-2 text-sm leading-relaxed text-slate-200">{aiStudySchedule.strategy}</p>
                    </section>
                  )}

                  {aiStudySchedule.cannotCoverAll && (
                    <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                      There is not enough time before the exam to schedule every topic for even a 10-minute session. This plan covers {aiStudySchedule.coverageCount} of {aiStudySchedule.totalTopics} topics; at {aiScheduleDailyMinutes} minutes per day, full minimum coverage needs at least {aiStudySchedule.minimumDaysRequired} days. Increase daily study time or prioritize the topics currently scheduled.
                    </div>
                  )}

                  {aiStudySchedule.compressed && !aiStudySchedule.cannotCoverAll && (
                    <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                      Your available time is shorter than the recommended depth for every topic. The AI has still scheduled every syllabus topic and shortened sessions to fit your daily limit. For fuller topic coverage, aim for about {Math.max(0.5, Math.round(aiStudySchedule.recommendedDailyMinutes / 30) / 2)} hours per day.
                    </div>
                  )}

                  {!aiStudySchedule.daysRemaining && (
                    <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">The configured exam date has passed, so there are no future study sessions to schedule.</div>
                  )}

                  <section className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-bold text-white">Full syllabus schedule</h3>
                        <p className="mt-1 text-xs text-slate-400">{aiStudySchedule.coverageCount} of {aiStudySchedule.totalTopics} topics assigned · sessions ordered by AI priority</p>
                      </div>
                      <button type="button" onClick={() => setShowFullAiSchedule((show) => !show)} className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-slate-700">
                        {showFullAiSchedule ? 'Show next 7 days' : 'Show all scheduled days'}
                      </button>
                    </div>
                    {aiStudySchedule.sessions.length ? (
                      (() => {
                        const todayTime = aiScheduleInput.today.getTime();
                        const visibleSessions = showFullAiSchedule
                          ? aiStudySchedule.sessions
                          : aiStudySchedule.sessions.filter((session) => {
                            const offset = Date.parse(`${session.date}T12:00:00`) - todayTime;
                            return offset >= 0 && offset < 7 * 24 * 60 * 60 * 1000;
                          });
                        const groupedSessions = visibleSessions.reduce((groups, session) => {
                          (groups[session.date] ||= []).push(session);
                          return groups;
                        }, {});
                        return Object.entries(groupedSessions).sort(([left], [right]) => left.localeCompare(right)).map(([date, sessions]) => (
                          <div key={date} className="mb-5 last:mb-0">
                            <h4 className="mb-2 border-b border-slate-700 pb-2 text-sm font-bold text-teal-200">{new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h4>
                            <div className="space-y-2">
                              {sessions.map((session) => (
                                <article key={session.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700/80 bg-slate-900/70 p-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="font-semibold text-white">{session.topic}</p>
                                    <p className="mt-0.5 text-xs text-slate-400">{session.subject} · Weightage {session.weightage} · {session.completion}% complete · {session.accuracy}% accuracy</p>
                                  </div>
                                  <span className="rounded-full border border-slate-600 px-2 py-1 text-[10px] font-bold text-slate-300">{session.duration} min</span>
                                  <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${getPriorityColorClass(session.priority)}`}>{session.priority}</span>
                                  <button
                                    type="button"
                                    onClick={() => { setSelectedSubject(session.subject); setSelectedTopic(session.topic); setCurrentView('topics'); }}
                                    className="rounded-md bg-teal-600/20 px-3 py-1.5 text-xs font-bold text-teal-200 hover:bg-teal-600/40"
                                  >
                                    Practice
                                  </button>
                                </article>
                              ))}
                            </div>
                          </div>
                        ));
                      })()
                    ) : (
                      <p className="rounded-lg border border-slate-700 bg-slate-900/70 p-4 text-sm text-slate-400">No upcoming sessions are available. Check the exam date and regenerate the schedule.</p>
                    )}
                  </section>
                </>
              )}
            </div>
          )}

          {currentView === 'planner' && (
            <div className="max-w-6xl mx-auto space-y-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-300">Smart Study Planner</p>
                  <h2 className="mt-2 text-3xl font-bold text-white">{selectedExam === 'CONSTABLE' ? 'TS Constable' : 'TS SI'} preparation plan</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setCurrentView('dashboard')} className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-bold text-slate-300 hover:bg-slate-800">Dashboard</button>
                </div>
              </div>

              <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
                {[
                  { label: 'Overall Progress', value: `${plannerViewData?.summary?.overallProgress ?? 0}%` },
                  { label: 'Syllabus Completion', value: `${plannerViewData?.summary?.syllabusCompletion ?? 0}%` },
                  { label: 'Tests Attempted', value: plannerViewData?.summary?.testsAttempted ?? selectedExamHistory.length },
                  { label: 'Average Accuracy', value: `${plannerViewData?.summary?.averageAccuracy ?? 0}%` },
                  { label: 'Critical Topics', value: plannerViewData?.summary?.criticalTopics ?? 0 }
                ].map((metric) => (
                  <div key={metric.label} className="rounded-xl border border-slate-700 bg-slate-800/80 p-4">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">{metric.label}</p>
                    <p className="mt-3 text-2xl font-black text-white">{metric.value}</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <h3 className="text-lg font-bold text-white">Topic weightage</h3>
                    <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-slate-400">{selectedExam}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <div className="max-h-[420px] overflow-y-auto rounded-xl border border-slate-700">
                      <table className="min-w-full text-left text-xs">
                        <thead className="sticky top-0 z-10 bg-slate-800/95 backdrop-blur-sm">
                          <tr className="border-b border-slate-700 text-slate-400">
                            <th className="pb-2 pl-3 pr-3 pt-3 font-semibold">Topic</th>
                            <th className="pb-2 pr-3 pt-3 font-semibold">Weightage</th>
                            <th className="pb-2 pr-3 pt-3 font-semibold">Accuracy</th>
                            <th className="pb-2 pr-3 pt-3 font-semibold">Completion</th>
                            <th className="pb-2 pr-3 pt-3 font-semibold">Priority</th>
                            <th className="pb-2 pr-3 pt-3 font-semibold">Last Attempt</th>
                            <th className="pb-2 pr-3 pt-3 font-semibold">Recommended</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(plannerViewData?.topicMetrics || []).map((metric) => (
                            <tr key={`${metric.subject}-${metric.topic}`} className="border-b border-slate-800 text-slate-300">
                              <td className="py-3 pl-3 pr-3"><div className="font-semibold text-white">{metric.topic}</div><div className="text-[10px] text-slate-400">{metric.subject}</div></td>
                              <td className="py-3 pr-3">{metric.weightage}</td>
                              <td className="py-3 pr-3"><span className={getProgressColorClass(metric.accuracy)}>{metric.accuracy}%</span></td>
                              <td className="py-3 pr-3">{metric.completion}%</td>
                              <td className="py-3 pr-3"><span className={`rounded-full border px-2 py-1 font-bold ${getPriorityColorClass(metric.priority)}`}>{metric.priority}</span></td>
                              <td className="py-3 pr-3">{metric.lastAttempted || 'Not attempted'}</td>
                              <td className="py-3 pr-3">{metric.recommendedMinutes} min</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <form onSubmit={handleAddPlannerTask} className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                  <h3 className="text-lg font-bold text-white">Add manual task</h3>
                  <div className="mt-4 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs text-slate-400">
                        Subject
                        <select
                          value={plannerTaskForm.subject}
                          onChange={(event) => setPlannerTaskForm((previous) => ({
                            ...previous,
                            subject: event.target.value,
                            topic: SUBJECT_TOPICS[event.target.value]?.includes(previous.topic)
                              ? previous.topic
                              : SUBJECT_TOPICS[event.target.value]?.[0] || ''
                          }))}
                          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none"
                        >
                          {Object.keys(SUBJECT_TOPICS).map((subject) => (
                            <option key={subject} value={subject}>{subject}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs text-slate-400">
                        Topic
                        <select
                          value={plannerTaskForm.topic}
                          onChange={(event) => setPlannerTaskForm((previous) => ({ ...previous, topic: event.target.value }))}
                          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none"
                        >
                          {(SUBJECT_TOPICS[plannerTaskForm.subject] || []).map((topic) => (
                            <option key={topic} value={topic}>{topic}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs text-slate-400">
                        Date
                        <input type="date" value={plannerTaskForm.date} onChange={(event) => setPlannerTaskForm((previous) => ({ ...previous, date: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none" />
                      </label>
                      <label className="text-xs text-slate-400">
                        Priority
                        <select value={plannerTaskForm.priority} onChange={(event) => setPlannerTaskForm((previous) => ({ ...previous, priority: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none">
                          <option value="CRITICAL">CRITICAL</option>
                          <option value="HIGH">HIGH</option>
                          <option value="MEDIUM">MEDIUM</option>
                          <option value="LOW">LOW</option>
                        </select>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs text-slate-400">
                        Start time
                        <input type="time" value={plannerTaskForm.startTime} onChange={(event) => setPlannerTaskForm((previous) => ({ ...previous, startTime: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none" />
                      </label>
                      <label className="text-xs text-slate-400">
                        End time
                        <input type="time" value={plannerTaskForm.endTime} onChange={(event) => setPlannerTaskForm((previous) => ({ ...previous, endTime: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none" />
                      </label>
                    </div>
                    <label className="text-xs text-slate-400">
                      Notes
                      <textarea value={plannerTaskForm.notes} onChange={(event) => setPlannerTaskForm((previous) => ({ ...previous, notes: event.target.value }))} rows={3} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none" />
                    </label>
                    <button type="submit" className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-500">Add task to calendar</button>
                  </div>
                </form>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-white">Generated schedule</h3>
                    <span className="text-xs text-slate-400">{selectedPlannerTasks.length} tasks</span>
                  </div>
                  <div className="mt-4 space-y-3">
                    {selectedPlannerTasks.slice(0, 8).map((task) => (
                      <div key={task.id} className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-bold text-white">{task.subject} · {task.topic}</p>
                            <p className="text-[11px] text-slate-400">{task.date} • {task.startTime} - {task.endTime}</p>
                          </div>
                          <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${getPriorityColorClass(task.priority)}`}>{task.priority}</span>
                        </div>
                        <p className="mt-2 text-xs leading-6 text-slate-300">Why this task? {task.reason}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" onClick={() => updatePlannerTask(task.id, { status: task.status === 'completed' ? 'scheduled' : 'completed' })} className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] font-bold text-emerald-200">{task.status === 'completed' ? 'Mark active' : 'Mark completed'}</button>
                          <button type="button" onClick={() => deletePlannerTask(task.id)} className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[10px] font-bold text-red-200">Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-white">Calendar</h3>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => { const nextMonth = new Date(plannerYear, plannerMonth - 1, 1); setPlannerMonth(nextMonth.getMonth()); setPlannerYear(nextMonth.getFullYear()); }} className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">Prev</button>
                      <button type="button" onClick={() => { const nextMonth = new Date(); setPlannerMonth(nextMonth.getMonth()); setPlannerYear(nextMonth.getFullYear()); }} className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">Today</button>
                      <button type="button" onClick={() => { const nextMonth = new Date(plannerYear, plannerMonth + 1, 1); setPlannerMonth(nextMonth.getMonth()); setPlannerYear(nextMonth.getFullYear()); }} className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">Next</button>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-slate-400">{new Date(plannerYear, plannerMonth, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })}</p>
                  <div className="mt-4 grid grid-cols-7 gap-2 text-center text-[10px] uppercase tracking-[0.2em] text-slate-400">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <div key={day}>{day}</div>)}
                  </div>
                  <div className="mt-3 grid grid-cols-7 gap-2">
                    {Array.from({ length: 42 }, (_, index) => {
                      const firstDayOfMonth = new Date(plannerYear, plannerMonth, 1);
                      const dayPointer = new Date(firstDayOfMonth);
                      dayPointer.setDate(1 - firstDayOfMonth.getDay() + index);
                      const dateKey = dayPointer.toISOString().split('T')[0];
                      const isCurrentMonth = dayPointer.getMonth() === plannerMonth;
                      const dateTasks = selectedPlannerTasks.filter((task) => task.date === dateKey);
                      return (
                        <button key={dateKey + index} type="button" onClick={() => setPlannerSelectedDate(dateKey)} className={`min-h-16 rounded-lg border p-1 text-left ${isCurrentMonth ? 'border-slate-700 bg-slate-900/70' : 'border-slate-800 bg-slate-950/30'} ${plannerSelectedDate === dateKey ? 'border-teal-500/40 ring-1 ring-teal-500/30' : ''}`}>
                          <span className={`text-[10px] font-semibold ${isCurrentMonth ? 'text-slate-200' : 'text-slate-500'}`}>{dayPointer.getDate()}</span>
                          <div className="mt-1 space-y-1">
                            {dateTasks.slice(0, 2).map((task) => (
                              <span key={task.id} className={`block rounded-sm px-1 text-[8px] font-semibold ${getPriorityColorClass(task.priority)}`}>{task.topic.slice(0, 8)}</span>
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/50 p-3">
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Selected day</p>
                    <p className="mt-2 text-sm font-bold text-white">{plannerSelectedDate}</p>
                    <div className="mt-3 space-y-2">
                      {(selectedPlannerTasks.filter((task) => task.date === plannerSelectedDate).length ? selectedPlannerTasks.filter((task) => task.date === plannerSelectedDate) : []).map((task) => (
                        <div key={task.id} className="rounded-lg border border-slate-700 bg-slate-800 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-bold text-white">{task.topic}</p>
                            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${getPriorityColorClass(task.priority)}`}>{task.priority}</span>
                          </div>
                          <p className="mt-1 text-[10px] text-slate-400">{task.startTime} - {task.endTime} • {task.duration} min</p>
                        </div>
                      )) || <p className="text-xs text-slate-400">No tasks scheduled for this date.</p>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TOPIC SELECTION VIEW */}
          {currentView === 'revision-mock' && (
            <div className="mx-auto max-w-4xl space-y-6">
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setCurrentView('dashboard')} aria-label="Back to dashboard" className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800">
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-300">Syllabus Modules · All</p>
                  <h2 className="text-2xl font-bold text-white">Revision & Mock Test</h2>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5 shadow-lg">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button type="button" aria-pressed={revisionMockMode === 'revision-mock'} onClick={() => { setRevisionMockMode('revision-mock'); setRevisionMockQuestionCount(60); setRevisionMockDurationMinutes(60); }} className={`rounded-xl border p-4 text-left transition ${revisionMockMode === 'revision-mock' ? 'border-teal-400/50 bg-teal-500/10' : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'}`}>
                    <span className="block text-sm font-bold text-white">Topic revision mock</span>
                    <span className="mt-1 block text-xs leading-5 text-slate-400">Weighted blocks from practiced topics. Lower-accuracy topics are prioritized.</span>
                  </button>
                  <button type="button" aria-pressed={revisionMockMode === 'exam-day'} onClick={() => { setRevisionMockMode('exam-day'); setRevisionMockQuestionCount(120); setRevisionMockDurationMinutes(120); }} className={`rounded-xl border p-4 text-left transition ${revisionMockMode === 'exam-day' ? 'border-indigo-400/50 bg-indigo-500/10' : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'}`}>
                    <span className="block text-sm font-bold text-white">Exam-day simulation</span>
                    <span className="mt-1 block text-xs leading-5 text-slate-400">A timed 120-question practice run through app subjects in sequence.</span>
                  </button>
                </div>
                <p className="mt-4 text-sm leading-6 text-slate-300">
                  {revisionMockMode === 'exam-day'
                    ? <>This is an <strong className="text-white">approximate practice simulation</strong> for <strong className="text-white">{selectedExam}</strong>, not an official paper blueprint. It uses your practiced topics and the app&apos;s subject order; unavailable subjects fall back to other practiced topics.</>
                    : <>Build a timed mixed-subject test from topics you have already practiced for <strong className="text-white">{selectedExam}</strong>. Each 10-question block focuses on one practiced topic; results update progress separately for every topic tested.</>}
                </p>
                <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="text-xs font-semibold text-slate-300">
                    Number of questions
                    <select value={revisionMockQuestionCount} onChange={(event) => setRevisionMockQuestionCount(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">
                      {[10, 20, 30, 40, 50, 60, 90, 120].map((count) => <option key={count} value={count}>{count} questions</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-slate-300">
                    Test duration
                    <select value={revisionMockDurationMinutes} onChange={(event) => setRevisionMockDurationMinutes(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">
                      {[10, 20, 30, 40, 50, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
                    </select>
                  </label>
                </div>
                <div className="mt-4 rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-bold text-white">Your {selectedExam} revision pool</p>
                    <span className="rounded-full bg-teal-500/10 px-2.5 py-1 text-[11px] font-bold text-teal-200">{selectedExamProgress.length} practiced topics</span>
                  </div>
                  {selectedExamProgress.length ? (
                    <p className="mt-2 text-xs leading-5 text-slate-400">
                      This test has up to {Math.ceil(revisionMockQuestionCount / 10)} topic sections drawn from your practiced pool. If your pool is larger, later tests rotate to other topics; if it is smaller, topics repeat. {revisionMockMode === 'exam-day' ? 'Sections follow the app subject order where possible.' : 'Topic selection prioritizes exam weightage and revision needs.'}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-amber-200">Complete at least one topic test first; the mock test only includes topics you have practiced.</p>
                  )}
                </div>
                {questionGenerationError && <p role="alert" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{questionGenerationError}</p>}
                {questionGenerationNotice && <p role="status" className="mt-4 rounded-lg border border-teal-500/20 bg-teal-500/5 px-3 py-2 text-xs text-teal-200">{questionGenerationNotice}</p>}
                <button type="button" onClick={() => void handleStartRevisionMockTest()} disabled={!selectedExamProgress.length || isGeneratingQuestions} className="mt-5 w-full rounded-xl bg-teal-600 px-4 py-3 text-sm font-bold text-white shadow transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50">
                  {isGeneratingQuestions ? 'Generating your practice questions…' : `Start ${revisionMockQuestionCount}-Question ${revisionMockMode === 'exam-day' ? 'Exam-day Simulation' : 'Revision Mock'}`}
                </button>
              </div>
            </div>
          )}

          {(currentView === 'topics' || currentView === 'topic-detail') && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-2xl font-bold text-white">Select Topic & Practice Level</h2>
                  <p className="text-xs text-slate-400">Choose a topic to ask Gemini AI for a new exam paper.</p>
                </div>
                <div className="flex space-x-2 overflow-x-auto pb-1 sm:pb-0">
                  {Object.keys(SUBJECT_TOPICS).map(subj => (
                    <button
                      key={subj}
                      onClick={() => { setSelectedSubject(subj); setSelectedTopic(SUBJECT_TOPICS[subj]?.[0] || ''); setCurrentView('topics'); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition ${selectedSubject === subj ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                        }`}
                    >
                      {subj}
                    </button>
                  ))}
                </div>
              </div>

              {questionGenerationError && (
                <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                  {questionGenerationError}
                </div>
              )}
              {currentView === 'topic-detail' && isGeneratingQuestions && <p role="status" className="text-xs text-teal-200">Generating Question...</p>}

              {currentView === 'topics' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {SUBJECT_TOPICS[selectedSubject]?.map((topic) => {
                    const progress = getTopicProgress(userProgress, selectedExam, selectedSubject, topic) || { level: 'Beginner', bestScore: 0, attempts: 0 };
                    const weightage = getTopicWeightage(selectedExam, selectedSubject, topic);
                    const progressValue = Math.min(100, Math.round(((progress.bestScore || 0) / 10) * 100));
                    const progressStatus = getProgressStatus(progressValue);
                    const progressClass = getStatusColorClass(progressStatus);

                    return (
                      <div
                        key={topic}
                        onClick={() => { setSelectedTopic(topic); setLearningVideos([]); setLearningVideosError(''); setIsLoadingLearningVideos(true); setStudyNotes(null); setSelectedNotesLearningStage(''); setStudyNotesError(''); setShowStudyNotes(false); setNotesDoubtMessages([]); setNotesDoubtInput(''); setNotesDoubtError(''); setCurrentView('topic-detail'); }}
                        className={`rounded-xl border p-5 cursor-pointer transition shadow-md flex justify-between items-center group ${progressClass} hover:border-blue-500`}
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="font-bold text-slate-100 group-hover:text-blue-400 transition">{topic}</h4>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${weightage.priority === 'High focus' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30' : 'bg-slate-700 text-slate-400'}`}>
                              {weightage.priority}
                            </span>
                          </div>
                          <p className="text-xs text-teal-300">Expected in exam: {weightage.range}</p>
                          <div className="flex items-center space-x-3 text-xs text-slate-200">
                            <span className="px-2 py-0.5 bg-slate-900/60 rounded font-semibold">{progress.level} Level</span>
                            <span>Best: {progress.bestScore}/10</span>
                            <span className={`px-2 py-0.5 rounded font-semibold ${getProgressColorClass(progressValue)}`}>{progressValue}%</span>
                          </div>
                        </div>
                        <button className="p-2 bg-blue-600/20 group-hover:bg-blue-600 text-blue-400 group-hover:text-white rounded-lg transition">
                          <Play className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* TOPIC DETAIL PAGE */}
              {currentView === 'topic-detail' && (
                <div className="mx-auto max-w-6xl space-y-8 pb-8">
                  <button
                    onClick={() => setCurrentView('topics')}
                    className="inline-flex items-center gap-2 text-xs font-semibold text-slate-400 transition hover:text-white"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>Back to Topics</span>
                  </button>

                  <header className="border-b border-slate-700/80 pb-6">
                    <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
                      <div className="max-w-3xl">
                        <p className="text-xs font-bold uppercase tracking-wider text-teal-300">AI-powered learning workspace</p>
                        <h2 className="mt-2 text-3xl font-bold text-white">AI-Generated Preparation Notes</h2>
                        <p className="mt-2 text-sm leading-relaxed text-slate-400">Master this topic from fundamentals to exam level with AI-powered explanations.</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleViewSelectedDriveNotes()}
                          disabled={isDriveNotesLoading}
                          className="inline-flex items-center gap-2 rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-xs font-semibold text-teal-200 hover:bg-teal-500/20 disabled:opacity-50"
                        >
                          <BookOpen className="h-4 w-4" />
                          {isDriveNotesLoading ? 'Loading notes...' : 'View Notes'}
                        </button>
                        {[selectedSubject, selectedTopic, normalizeExamForRequest(selectedExam), currentLearningLevel, 'AI Generated'].filter(Boolean).map((badge) => (
                          <span key={badge} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${badge === currentLearningLevel ? 'border-teal-500/40 bg-teal-500/10 text-teal-200' : 'border-slate-700 bg-slate-800 text-slate-300'}`}>
                            {badge}
                          </span>
                        ))}
                      </div>
                    </div>
                  </header>

                  <section aria-label="Quick Learning Videos" className="space-y-3 border-b border-slate-800 pb-6">
                    <div>
                      <h3 className="text-sm font-bold text-slate-100">Quick Learning Videos</h3>
                      <p className="mt-1 text-xs text-slate-400">Learn {selectedTopic} with curated YouTube resources.</p>
                    </div>
                    {isLoadingLearningVideos && <p role="status" className="text-xs text-slate-400">Loading Learning Videos...</p>}
                    {learningVideosError && <p role="status" className="text-xs text-amber-200">{learningVideosError}</p>}
                    {!isLoadingLearningVideos && !learningVideosError && learningVideos.length === 0 && <p className="text-xs text-slate-500">No learning videos added yet.</p>}
                    {learningVideos.length > 0 && (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {learningVideos.map((video) => (
                          <article key={video.id} className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900/60">
                            <img
                              src={`https://img.youtube.com/vi/${encodeURIComponent(video.videoId)}/hqdefault.jpg`}
                              alt=""
                              loading="lazy"
                              onError={(event) => { event.currentTarget.hidden = true; }}
                              className="aspect-video w-full object-cover"
                            />
                            <div className="flex items-center justify-between gap-3 p-3">
                              <h4 className="min-w-0 text-sm font-semibold text-slate-100">{video.title}</h4>
                              <button type="button" onClick={() => setActiveTopicVideo(video)} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-600">
                                <Play className="h-3.5 w-3.5" />
                                Play here
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    {activeTopicVideo && learningVideos.some((video) => video.id === activeTopicVideo.id) && (
                      <YouTubeVideoPlayer video={activeTopicVideo} onClose={() => setActiveTopicVideo(null)} />
                    )}
                  </section>

                  <section aria-label="Learning progression" className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-bold text-slate-100">Your learning path</h3>
                      <span className="text-xs text-slate-400">Current: <strong className="text-teal-300">{currentLearningLevel}</strong></span>
                    </div>
                    <div className="flex snap-x gap-3 overflow-x-auto pb-2">
                      {LEARNING_STAGES.map((stage, index) => {
                        const isCurrent = index === currentLearningStageIndex;
                        const isPast = index < currentLearningStageIndex;
                        return (
                          <button
                            key={stage.name}
                            type="button"
                            onClick={() => handleSelectNotesLearningStage(stage.name)}
                            aria-pressed={isCurrent}
                            aria-label={`Select ${stage.name} notes level`}
                            className={`min-w-40 flex-1 snap-start rounded-lg border p-3 text-left transition hover:border-teal-500/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 ${isCurrent ? 'border-teal-500/50 bg-teal-500/10' : isPast ? 'border-slate-700 bg-slate-800/70' : 'border-slate-800 bg-slate-900/50'}`}
                          >
                            <div className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${isPast || isCurrent ? stage.color : 'bg-slate-700'}`} />
                              <span className={`text-xs font-bold ${isCurrent ? 'text-white' : isPast ? 'text-slate-200' : 'text-slate-500'}`}>{stage.name}</span>
                            </div>
                            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{stage.detail}</p>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {!showStudyNotes && (
                    <section className="flex flex-col gap-4 border-y border-slate-800 py-5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-start gap-3">
                        <BookOpen className="mt-0.5 h-5 w-5 shrink-0 text-teal-300" />
                        <div>
                          <h3 className="text-sm font-bold text-white">Start with AI-generated notes</h3>
                          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">Create structured concepts, rules, examples, shortcuts, and revision notes for this selected topic.</p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleLoadStudyNotes(Boolean(studyNotes))}
                        disabled={isLoadingStudyNotes}
                        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-teal-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-teal-500 disabled:opacity-50"
                      >
                        <Sparkles className="h-4 w-4" />
                        {isLoadingStudyNotes ? 'Generating Preparation Notes...' : studyNotes ? 'Show AI notes' : 'Generate AI notes'}
                      </button>
                    </section>
                  )}

                  {studyNotesError && (
                    <div className="flex flex-col gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-red-200">Unable to generate notes</h3>
                        <p className="mt-1 text-xs text-red-200/80">{studyNotesError}</p>
                      </div>
                      <button onClick={() => handleLoadStudyNotes(Boolean(studyNotes))} className="rounded-md border border-red-400/30 px-3 py-2 text-xs font-bold text-red-100 hover:bg-red-500/10">Try Again</button>
                    </div>
                  )}

                  {isLoadingStudyNotes && (
                    <div role="status" className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
                      <p className="text-sm font-semibold text-slate-200">Generating your selected topic notes...</p>
                      <div className="h-2 animate-pulse rounded-full bg-slate-800" />
                      <div className="h-2 w-3/4 animate-pulse rounded-full bg-slate-800" />
                    </div>
                  )}

                  {showStudyNotes && studyNotes && (
                    <>
                      <section className="relative overflow-hidden rounded-lg border border-teal-500/25 bg-slate-900 p-5 sm:p-6">
                        <div className="pointer-events-none absolute inset-y-0 right-0 w-1/3 bg-gradient-to-l from-teal-500/10 to-transparent" />
                        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <div className="max-w-3xl">
                            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-300">
                              <Sparkles className="h-4 w-4" />
                              <span>AI-generated preparation notes</span>
                            </div>
                            <h3 className="mt-2 text-xl font-bold text-white">{studyNotes.title}</h3>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                if (isNotesAudioPlaying) {
                                  stopNotesAudio();
                                  return;
                                }
                                handlePlayNotesAudio();
                              }}
                              className="inline-flex items-center gap-2 rounded-md border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs font-semibold text-teal-200 hover:bg-teal-500/15"
                              title="Listen to AI notes explanation"
                            >
                              {isNotesAudioPlaying ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                              {isNotesAudioPlaying ? 'Stop audio' : 'Audio explanation'}
                            </button>
                            <button onClick={() => handleLoadStudyNotes(true)} disabled={isLoadingStudyNotes} className="rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50">Refresh notes</button>
                            <button onClick={() => setShowStudyNotes(false)} aria-label="Hide AI notes" className="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-white">
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        {studyNotes.overview && <p className="relative mt-5 max-w-4xl text-sm leading-7 text-slate-300">{studyNotes.overview}</p>}
                      </section>

                      {visibleStudyNoteSections.length > 0 && (
                        <section aria-label="AI-generated notes content" className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          {visibleStudyNoteSections.filter((section) => !['examTips', 'quickRevision'].includes(section.key)).map((section) => {
                            const SectionIcon = section.icon;
                            const tone = NOTE_TONE_CLASSES[section.tone];
                            return (
                              <article key={section.key} className={`min-w-0 rounded-lg border bg-slate-900/70 p-4 ${tone.border}`}>
                                <div className="mb-3 flex items-center gap-2">
                                  <SectionIcon className={`h-4 w-4 ${tone.icon}`} />
                                  <h4 className={`text-sm font-bold ${tone.label}`}>{section.title}</h4>
                                  <span className="ml-auto text-[10px] text-slate-500">{section.stage}</span>
                                </div>
                                <ul className="space-y-3">
                                  {section.items.map((item, index) => (
                                    <li key={`${section.key}-${index}`} className="group flex items-start gap-3 border-t border-slate-800 pt-3 first:border-0 first:pt-0">
                                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone.icon.replace('text-', 'bg-')}`} />
                                      <p className="min-w-0 flex-1 whitespace-pre-line text-sm leading-6 text-slate-300">{item}</p>
                                      <div className="flex shrink-0 items-center gap-1">
                                        <button
                                          type="button"
                                          title="Read this note aloud"
                                          aria-label={`Read ${section.title} aloud`}
                                          onClick={() => playNotesAudio(`${section.title}. ${item}`, section.title)}
                                          className="rounded p-1 text-slate-600 transition hover:bg-slate-800 hover:text-teal-300"
                                        >
                                          <Volume2 className="h-4 w-4" />
                                        </button>
                                        <button
                                          type="button"
                                          title="Ask AI about this note"
                                          aria-label={`Ask AI about ${section.title}`}
                                          onClick={() => {
                                            setNotesDoubtInput(`Explain this ${section.title.toLowerCase()} in simpler words: ${item}`);
                                            document.getElementById('ai-notes-doubt')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                          }}
                                          className="rounded p-1 text-slate-600 transition hover:bg-slate-800 hover:text-teal-300"
                                        >
                                          <Brain className="h-4 w-4" />
                                        </button>
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              </article>
                            );
                          })}
                        </section>
                      )}
                    </>
                  )}

                  {showStudyNotes && studyNotes?.examTips?.length > 0 && (
                    <section aria-labelledby="notes-exam-strategy" className="border-y border-emerald-500/25 py-5">
                      <div className="mb-3 flex items-center gap-2">
                        <Target className="h-4 w-4 text-emerald-300" />
                        <h3 id="notes-exam-strategy" className="text-sm font-bold text-emerald-200">Exam Strategy</h3>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {studyNotes.examTips.map((tip, index) => (
                          <div key={`exam-tip-${index}`} className="flex items-start gap-3 rounded-md bg-emerald-500/5 p-3 text-sm leading-6 text-slate-300">
                            <span className="mt-0.5 text-emerald-300">{String(index + 1).padStart(2, '0')}</span>
                            <p>{tip}</p>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {showStudyNotes && studyNotes?.quickRevision?.length > 0 && (
                    <section aria-labelledby="notes-quick-revision" className="rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-4 sm:p-5">
                      <div className="mb-3 flex items-center gap-2">
                        <RotateCcw className="h-4 w-4 text-indigo-300" />
                        <h3 id="notes-quick-revision" className="text-sm font-bold text-indigo-200">Quick Revision</h3>
                      </div>
                      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {studyNotes.quickRevision.map((item, index) => (
                          <li key={`quick-revision-${index}`} className="flex items-start gap-2 text-sm leading-6 text-slate-300">
                            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-300" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {showStudyNotes && studyNotes && (
                    <section id="ai-notes-doubt" aria-labelledby="ai-notes-doubt-title" className="overflow-hidden rounded-lg border border-teal-500/25 bg-slate-900 shadow-lg shadow-black/10">
                      <div className="flex flex-col gap-3 border-b border-slate-800 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                        <div className="flex items-start gap-3">
                          <span className="rounded-md bg-teal-500/10 p-2 text-teal-300"><Brain className="h-5 w-5" /></span>
                          <div>
                            <h3 id="ai-notes-doubt-title" className="text-base font-bold text-white">Ask AI — Doubt Solver</h3>
                            <p className="mt-1 text-xs text-slate-400">Ask about {selectedTopic}. Answers use your exam, level, and generated notes as context.</p>
                          </div>
                        </div>
                        <span className="self-start rounded-full border border-teal-500/20 px-2.5 py-1 text-[11px] font-semibold text-teal-200">{normalizeExamForRequest(selectedExam)} · {currentLearningLevel}</span>
                      </div>

                      <div className="space-y-4 p-4 sm:p-5">
                        {notesDoubtMessages.length > 0 && (
                          <div ref={notesDoubtLogRef} role="log" aria-live="polite" aria-label="Doubt solver conversation" className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
                            {notesDoubtMessages.map((message, index) => (
                              <div key={`notes-doubt-${index}`} className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-4 py-3 text-sm leading-6 ${message.sender === 'user' ? 'bg-teal-700/70 text-white' : 'border border-slate-700 bg-slate-800 text-slate-200'}`}>
                                  <p className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${message.sender === 'user' ? 'text-teal-100/70' : 'text-teal-300'}`}>{message.sender === 'user' ? 'You' : 'AI Explanation'}</p>
                                  {message.text}
                                </div>
                              </div>
                            ))}
                            {isNotesDoubtLoading && (
                              <div role="status" className="flex items-center gap-3 text-xs text-slate-400">
                                <span className="flex gap-1" aria-hidden="true"><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300 [animation-delay:120ms]" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300 [animation-delay:240ms]" /></span>
                                🤖 AI is thinking...
                              </div>
                            )}
                          </div>
                        )}

                        {notesDoubtError && (
                          <div role="alert" className="flex flex-col gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="text-sm font-semibold text-red-200">Unable to answer right now</p>
                              <p className="mt-1 text-xs text-red-200/80">{notesDoubtError}</p>
                            </div>
                            <button
                              onClick={() => handleSendNotesDoubt([...notesDoubtMessages].reverse().find((message) => message.sender === 'user')?.text, true)}
                              disabled={isNotesDoubtLoading}
                              className="rounded-md border border-red-400/30 px-3 py-2 text-xs font-bold text-red-100 hover:bg-red-500/10 disabled:opacity-50"
                            >Try Again</button>
                          </div>
                        )}

                        {notesDoubtMessages.length === 0 && (
                          <div className="rounded-md bg-slate-800/60 p-3 text-xs text-slate-400">
                            <p className="mb-2 font-semibold text-slate-300">Try asking</p>
                            <div className="flex flex-wrap gap-2">
                              {['Explain this in simple words', 'Why is this formula used?', 'Give me another example', 'Solve step by step', 'Explain in Telugu', 'Give me a shortcut'].map((prompt) => (
                                <button key={prompt} type="button" onClick={() => setNotesDoubtInput(prompt)} className="rounded-full border border-slate-700 px-2.5 py-1.5 text-left text-[11px] text-slate-400 transition hover:border-teal-500/50 hover:text-teal-200">{prompt}</button>
                              ))}
                            </div>
                          </div>
                        )}

                        <form onSubmit={(event) => { event.preventDefault(); void handleSendNotesDoubt(); }} className="rounded-md border border-slate-700 bg-slate-950/70 p-3 focus-within:border-teal-500/50">
                          <label htmlFor="notes-doubt-input" className="sr-only">Ask a question about {selectedTopic}</label>
                          <textarea
                            id="notes-doubt-input"
                            rows={3}
                            maxLength={2000}
                            value={notesDoubtInput}
                            onChange={(event) => setNotesDoubtInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                if (!isNotesDoubtLoading) void handleSendNotesDoubt();
                              }
                            }}
                            placeholder={`Ask anything about ${selectedTopic}...`}
                            className="block min-h-20 w-full resize-y bg-transparent text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600"
                          />
                          <div className="mt-2 flex items-center justify-between gap-3 border-t border-slate-800 pt-2">
                            <span className="text-[10px] text-slate-500">{notesDoubtInput.length}/2000 · Enter to ask, Shift + Enter for a new line</span>
                            <button type="submit" disabled={!notesDoubtInput.trim() || isNotesDoubtLoading} className="inline-flex shrink-0 items-center gap-2 rounded-md bg-teal-600 px-3 py-2 text-xs font-bold text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-45">
                              <Send className="h-3.5 w-3.5" />
                              Ask AI
                            </button>
                          </div>
                        </form>

                        {notesDoubtMessages.at(-1)?.sender === 'ai' && !isNotesDoubtLoading && (
                          <div className="flex flex-wrap gap-2" aria-label="Follow-up questions">
                            {[
                              ['Explain simpler', 'Please explain your last answer in simpler words.'],
                              ['Another example', 'Give me another example for this topic.'],
                              ['Show shortcut', 'Show me a shortcut for this topic.'],
                              ['Practice question', 'Give me one practice question for this topic and solve it step by step.'],
                              ['Explain in Telugu', 'Please explain your last answer in Telugu.'],
                              ['Step-by-step', 'Explain the steps in more detail.']
                            ].map(([label, prompt]) => (
                              <button key={label} type="button" onClick={() => void handleSendNotesDoubt(prompt)} className="rounded-full border border-slate-700 px-3 py-1.5 text-[11px] font-medium text-slate-400 transition hover:border-teal-500/50 hover:text-teal-200">{label}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>
                  )}

                  {showStudyNotes && studyNotes && (
                    <section aria-label="Topic mastery" className="flex flex-col gap-4 border-t border-slate-800 pt-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-teal-300">Topic Mastery</p>
                        <p className="mt-1 text-sm text-slate-200">{currentLearningLevel} · {visibleStudyNoteSections.length} AI note sections available</p>
                      </div>
                      {currentTopicProgress.attempts > 0 && (
                        <p className="text-xs text-slate-400">{currentTopicProgress.attempts} attempts · Best score {currentTopicProgress.bestScore}/10</p>
                      )}
                    </section>
                  )}

                  {/* Difficulty Progression Grid */}
                  <div>
                    <h4 className="text-sm font-bold text-slate-300 mb-3">Difficulty Levels & AI Test Launch</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {DIFFICULTY_LEVELS.map((lvl, idx) => {
                        const currentLvl = currentTopicProgress.level || "Beginner";
                        const currentLvlIdx = DIFFICULTY_LEVELS.indexOf(currentLvl);
                        const isUnlocked = idx <= currentLvlIdx;

                        return (
                          <div
                            key={lvl}
                            className={`p-4 rounded-xl border flex flex-col justify-between transition ${isUnlocked ? 'bg-slate-900/80 border-slate-700 text-slate-200' : 'bg-slate-900/30 border-slate-800 text-slate-600'
                              }`}
                          >
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-xs font-bold">LEVEL {idx + 1}</span>
                              {isUnlocked ? <Unlock className="w-3.5 h-3.5 text-emerald-400" /> : <Lock className="w-3.5 h-3.5 text-slate-600" />}
                            </div>
                            <p className="font-extrabold text-sm mb-3">{lvl}</p>
                            <button
                              disabled={!isUnlocked || isGeneratingQuestions}
                              onClick={() => handleStartTest(selectedTopic, lvl)}
                              className={`w-full py-2 rounded-lg text-xs font-bold transition ${isUnlocked ? 'bg-blue-600 hover:bg-blue-500 text-white shadow' : 'bg-slate-800 text-slate-600 cursor-not-allowed'
                                }`}
                            >
                              {isGeneratingQuestions ? 'Generating...' : isUnlocked ? 'Launch AI Test' : 'Locked'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Guarantee Banner */}
                  <div className="p-4 bg-emerald-950/40 border border-emerald-500/30 rounded-xl text-xs space-y-1">
                    <p className="font-bold text-emerald-300 flex items-center space-x-1.5">
                      <Sparkles className="w-4 h-4 text-emerald-400" />
                      <span>AI Fresh Question Set:</span>
                    </p>
                    <p className="text-slate-300">
                      Every attempt asks Gemini AI for 10 new questions specifically for <strong>{selectedTopic} ({currentTopicProgress.level || 'Beginner'})</strong>.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* LIVE TEST INTERFACE */}
          {currentView === 'test' && activeTestQuestions.length > 0 && (
            <div className="max-w-4xl mx-auto space-y-6">
              {/* Header */}
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex flex-col sm:flex-row justify-between items-center gap-3 shadow-lg">
                <div>
                  <div className="flex items-center space-x-2 text-xs text-slate-400">
                    <span>{selectedExam}</span> • <span>{['revision-mock', 'exam-day'].includes(activeTestMode) ? 'Practiced topics' : activeTestMode === 'bookmark-practice' ? 'Saved questions' : selectedSubject}</span> • <span className="text-blue-400 font-semibold">{['revision-mock', 'exam-day', 'bookmark-practice'].includes(activeTestMode) ? `${activeTestDurationSeconds / 60} min ${activeTestMode === 'exam-day' ? 'simulation' : 'practice'}` : `${activeTestDifficulty} Level`}</span>
                  </div>
                  <h3 className="text-lg font-bold text-white flex items-center space-x-2">
                    <span>{activeTestMode === 'revision-mock' ? 'Revision Mock Test' : activeTestMode === 'exam-day' ? 'Exam-day Practice Simulation' : activeTestMode === 'bookmark-practice' ? 'Saved-question Practice' : selectedTopic}</span>
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-md font-bold">
                      ✨ Attempt Seed #{testAttemptCounter}
                    </span>
                  </h3>
                </div>

              </div>
              {questionGenerationNotice && (
                <p className="text-xs text-teal-300 bg-teal-500/10 border border-teal-500/20 rounded-lg px-3 py-2">
                  {questionGenerationNotice}
                </p>
              )}
              {showExamFocusWarning && (
                <p role="alert" className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  You have been away from the exam.
                </p>
              )}
              {timeRemaining > 0 && timeRemaining <= 60 && (
                <p role="status" className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
                  <Clock className="h-4 w-4 shrink-0" />
                  1 minute remaining
                </p>
              )}

              {/* Question Card */}
              <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-xl space-y-6">
                <div className="flex justify-between items-center border-b border-slate-700 pb-3">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                    Question {currentQuestionIdx + 1} of {activeTestQuestions.length}
                  </span>
                  <span className="text-xs px-2.5 py-1 bg-slate-700/80 rounded-full text-slate-300">
                    {userAnswers[activeTestQuestions[currentQuestionIdx].id] ? 'Answered' : 'Unanswered'}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wider text-slate-400">
                  <span>Section: <strong className="text-slate-200">{activeTestQuestions[currentQuestionIdx].section || selectedSubject}</strong></span>
                  <span>Topic: <strong className="text-slate-200">{activeTestQuestions[currentQuestionIdx].topic || selectedTopic}</strong></span>
                  <span>Level: <strong className="text-slate-200">{activeTestQuestions[currentQuestionIdx].level || activeTestDifficulty}</strong></span>
                </div>

                <h4 className="text-lg font-semibold text-slate-100 leading-relaxed">
                  {activeTestQuestions[currentQuestionIdx].questionType && (
                    <span className="block text-[10px] uppercase tracking-wider text-teal-400 mb-2">
                      {activeTestQuestions[currentQuestionIdx].questionType}
                    </span>
                  )}
                  {activeTestQuestions[currentQuestionIdx].question}
                </h4>

                {/* Options */}
                <div className="space-y-3 pt-2">
                  {activeTestQuestions[currentQuestionIdx].options.map((opt, optIdx) => {
                    const qId = activeTestQuestions[currentQuestionIdx].id;
                    const isSelected = userAnswers[qId] === opt;

                    return (
                      <button
                        key={optIdx}
                        onClick={() => handleSelectOption(qId, opt)}
                        className={`w-full text-left p-4 rounded-xl border font-medium text-sm transition flex items-center justify-between ${isSelected ? 'bg-blue-600/20 border-blue-500 text-white shadow-md' : 'bg-slate-900/60 border-slate-700 text-slate-300 hover:bg-slate-700/50'
                          }`}
                      >
                        <span>{opt}</span>
                        <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${isSelected ? 'border-blue-400 bg-blue-500' : 'border-slate-600'
                          }`}>
                          {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Question Palette */}
                <div className="pt-4 border-t border-slate-700">
                  <p className="text-xs font-semibold text-slate-400 mb-2">Question Palette:</p>
                  <div className="flex flex-wrap gap-2">
                    {activeTestQuestions.map((q, idx) => (
                      <button
                        key={idx}
                        onClick={() => setCurrentQuestionIdx(idx)}
                        className={`w-8 h-8 rounded-lg text-xs font-bold transition ${idx === currentQuestionIdx
                          ? 'ring-2 ring-blue-400 bg-blue-600 text-white'
                          : userAnswers[q.id] ? 'bg-emerald-600/30 text-emerald-400 border border-emerald-500/40' : 'bg-slate-900 text-slate-400 border border-slate-700'
                          }`}
                      >
                        {idx + 1}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Bottom Navigation */}
                <div className="flex justify-between items-center pt-4">
                  <button
                    disabled={currentQuestionIdx === 0}
                    onClick={() => setCurrentQuestionIdx(prev => prev - 1)}
                    className="px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-xs font-bold rounded-lg transition"
                  >
                    Previous
                  </button>

                  <button
                    onClick={() => setIsSubmitModalOpen(true)}
                    className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg transition"
                  >
                    Submit Test
                  </button>

                  <button
                    disabled={currentQuestionIdx === activeTestQuestions.length - 1}
                    onClick={() => setCurrentQuestionIdx(prev => prev + 1)}
                    className="px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-xs font-bold rounded-lg transition"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TEST RESULT VIEW */}
          {currentView === 'result' && activeAttemptData && (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-xl space-y-6">
                <div className="flex justify-between items-center border-b border-slate-700 pb-4">
                  <div>
                    <span className="text-xs text-blue-400 font-semibold">{['revision-mock', 'exam-day'].includes(activeAttemptData.mode) ? `${activeAttemptData.total} questions · Practiced topics` : activeAttemptData.mode === 'bookmark-practice' ? `${activeAttemptData.total} saved questions` : `${activeAttemptData.topic} • ${activeAttemptData.difficulty}`}</span>
                    <h2 className="text-2xl font-extrabold text-white">{activeAttemptData.mode === 'exam-day' ? 'Exam-day Simulation Results' : activeAttemptData.mode === 'revision-mock' ? 'Revision Mock Results' : activeAttemptData.mode === 'bookmark-practice' ? 'Saved-question Practice Results' : 'Test Results'}</h2>
                  </div>
                  <span className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-wider ${activeAttemptData.status === 'LEVEL PASSED' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                    }`}>
                    {activeAttemptData.status}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 text-center">
                    <p className="text-xs text-slate-400">Score</p>
                    <p className="text-2xl font-black text-white mt-1">{activeAttemptData.score} / {activeAttemptData.total}</p>
                  </div>
                  <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 text-center">
                    <p className="text-xs text-slate-400">Percentage</p>
                    <p className="text-2xl font-black text-blue-400 mt-1">{activeAttemptData.percentage}%</p>
                  </div>
                  <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 text-center">
                    <p className="text-xs text-slate-400">Accuracy</p>
                    <p className="text-2xl font-black text-emerald-400 mt-1">{activeAttemptData.accuracy}%</p>
                  </div>
                  <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 text-center">
                    <p className="text-xs text-slate-400">Time Taken</p>
                    <p className="text-2xl font-black text-amber-400 mt-1">{activeAttemptData.timeTaken}</p>
                  </div>
                  <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 text-center">
                    <p className="text-xs text-slate-400">Correct</p>
                    <p className="text-2xl font-black text-emerald-400 mt-1">{activeAttemptData.correct ?? activeAttemptData.score}</p>
                  </div>
                  <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 text-center">
                    <p className="text-xs text-slate-400">Incorrect</p>
                    <p className="text-2xl font-black text-red-400 mt-1">{activeAttemptData.incorrect ?? 0}</p>
                  </div>
                  <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 text-center">
                    <p className="text-xs text-slate-400">Unanswered</p>
                    <p className="text-2xl font-black text-amber-400 mt-1">{activeAttemptData.unanswered ?? 0}</p>
                  </div>
                </div>

                {activeAttemptData.topicBreakdown?.length > 0 && (
                  <section className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
                    <h3 className="text-sm font-bold text-white">Topic performance</h3>
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {activeAttemptData.topicBreakdown.map((item) => (
                        <div key={`${item.subject}:${item.topic}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
                          <span className="min-w-0 truncate text-xs text-slate-200">{item.subject} · {item.topic}</span>
                          <span className="shrink-0 text-xs font-bold text-teal-200">{item.correct}/{item.total} · {item.accuracy}%</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
                  <h3 className="text-sm font-bold text-white">Answer Key</h3>
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                    {activeAttemptData.questions?.map((question, index) => (
                      <p key={question.questionId || index} className="rounded-md bg-slate-800 px-3 py-2 text-slate-300">
                        <span className="font-bold text-slate-100">{index + 1}.</span> {question.correctAnswer}
                      </p>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  {['revision-mock', 'exam-day'].includes(activeAttemptData.mode) ? (
                    <button
                      disabled={isGeneratingQuestions}
                      onClick={() => { setQuestionGenerationError(''); void handleStartRevisionMockTest(activeAttemptData.mode); }}
                      aria-busy={isGeneratingQuestions}
                      className="flex-1 py-3 bg-teal-600 hover:bg-teal-500 text-white font-bold text-xs rounded-xl shadow transition disabled:cursor-wait disabled:opacity-60"
                    >
                      {isGeneratingQuestions ? 'Preparing New Practice...' : activeAttemptData.mode === 'exam-day' ? 'Take Another Simulation' : 'Take Another Revision Mock'}
                    </button>
                  ) : activeAttemptData.mode === 'bookmark-practice' ? (
                    <button type="button" onClick={() => setCurrentView('profile')} className="flex-1 rounded-xl bg-teal-600 py-3 text-xs font-bold text-white hover:bg-teal-500">Manage Saved Questions</button>
                  ) : (
                    <button
                    disabled={isGeneratingQuestions}
                    onClick={() => handleStartTest(selectedTopic, activeTestDifficulty)}
                    aria-busy={isGeneratingQuestions}
                    className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow transition flex items-center justify-center space-x-2 disabled:cursor-wait disabled:opacity-60"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>{isGeneratingQuestions ? 'Preparing Reattempt...' : 'Attempt Again (New AI Questions)'}</span>
                    </button>
                  )}
                  <button
                    onClick={() => setCurrentView('topics')}
                    className="flex-1 py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold text-xs rounded-xl transition"
                  >
                    Choose Another Topic
                  </button>
                </div>
              </div>

              {/* Detailed Review */}
              <div className="space-y-4">
                <h3 className="text-lg font-bold text-white">Solutions & Step-by-Step Explanations</h3>
                {activeAttemptData.questions?.map((q, idx) => {
                  const questionId = q.questionId || q.id;
                  const userAns = q.userAnswer ?? activeAttemptData.answers?.[questionId] ?? '';
                  const isCorrect = q.status === 'CORRECT' || Boolean(normalizeAnswer(userAns) && normalizeAnswer(userAns) === normalizeAnswer(q.correctAnswer));
                  const isUnanswered = q.status === 'UNANSWERED' || !normalizeAnswer(userAns);
                  const statusClass = isUnanswered
                    ? 'bg-amber-500/20 text-amber-300'
                    : isCorrect ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400';

                  return (
                    <div key={questionId || idx} className="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-3">
                      <div className="flex justify-between items-start">
                        <span className="text-xs font-bold text-slate-400">Question {idx + 1}</span>
                        <span className={`px-2.5 py-0.5 rounded text-xs font-bold ${statusClass}`}>
                          {isUnanswered ? 'UNANSWERED' : isCorrect ? 'CORRECT' : 'INCORRECT'}
                        </span>
                      </div>

                      <p className="text-sm font-semibold text-slate-100">{q.question}</p>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1">
                        <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-700">
                          <span className="text-slate-400 block mb-1">Your Answer:</span>
                          <span className={`font-bold ${isUnanswered ? 'text-amber-300' : isCorrect ? 'text-emerald-400' : 'text-red-400'}`}>
                            {userAns || 'Not Answered'}
                          </span>
                        </div>
                        <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-700">
                          <span className="text-slate-400 block mb-1">Correct Answer:</span>
                          <span className="text-emerald-400 font-bold">{q.correctAnswer}</span>
                        </div>
                      </div>

                      <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-700/50 text-xs space-y-1">
                        <p className="text-slate-300"><span className="text-blue-400 font-bold">Explanation:</span> {q.explanation}</p>
                        {q.shortcut && <p className="text-amber-300"><span className="text-amber-400 font-bold">Shortcut:</span> {q.shortcut}</p>}
                      </div>

                      <button
                        onClick={() => handleExplainWithAI({ ...q, id: questionId })}
                        className="flex items-center space-x-1.5 text-xs text-indigo-400 hover:text-indigo-300 font-semibold transition"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>AI Deep Explanation</span>
                      </button>

                      <div className="flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={isSavingBookmarks}
                          aria-pressed={savedQuestions.some((item) => item.id === String(questionId))}
                          onClick={() => void handleToggleBookmark({ ...q, id: questionId }, activeAttemptData)}
                          className="text-xs font-semibold text-amber-300 hover:text-amber-200 disabled:opacity-50"
                        >
                          {savedQuestions.some((item) => item.id === String(questionId)) ? 'Remove from saved questions' : 'Save question'}
                        </button>
                        <button type="button" onClick={() => handleExplainInTelugu({ ...q, userAnswer: userAns })} className="text-xs font-semibold text-teal-300 hover:text-teal-200">
                          Explain in Telugu
                        </button>
                        {(q.topic || activeAttemptData.topic) && (
                          <button type="button" onClick={() => handlePracticeTopic(q.subject || activeAttemptData.subject || selectedSubject, q.topic || activeAttemptData.topic)} className="text-xs font-semibold text-blue-300 hover:text-blue-200">
                            Practice this topic
                          </button>
                        )}
                      </div>

                      {!isCorrect && (
                        <div className="border-t border-slate-700/60 pt-3 space-y-3">
                          <button
                            onClick={() => handleOpenMistakeChat(questionId)}
                            className="flex items-center space-x-1.5 text-xs text-teal-300 hover:text-teal-200 font-semibold transition"
                          >
                            <Brain className="w-3.5 h-3.5" />
                            <span>{reviewChatQuestionId === questionId ? 'Close AI mistake chat' : 'Chat with AI about this mistake'}</span>
                          </button>

                          {reviewChatQuestionId === questionId && (
                            <div className="bg-slate-900 border border-teal-500/20 rounded-xl p-3 space-y-3">
                              <div className="max-h-56 overflow-y-auto space-y-2">
                                {reviewChatMessages.map((message, messageIndex) => (
                                  <div key={messageIndex} className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <p className={`max-w-[90%] rounded-lg px-3 py-2 text-xs whitespace-pre-line ${message.sender === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-200'}`}>
                                      {message.text}
                                    </p>
                                  </div>
                                ))}
                                {isReviewChatLoading && <p className="text-xs text-slate-400">AI is reviewing your mistake...</p>}
                              </div>
                              <div className="flex gap-2">
                                <input
                                  value={reviewChatInput}
                                  onChange={(event) => setReviewChatInput(event.target.value)}
                                  onKeyDown={(event) => event.key === 'Enter' && !isReviewChatLoading && handleSendMistakeChat(q, userAns)}
                                  placeholder="Ask why your answer was wrong..."
                                  className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-teal-500"
                                />
                                <button
                                  onClick={() => handleSendMistakeChat(q, userAns)}
                                  disabled={isReviewChatLoading}
                                  aria-label="Send mistake question"
                                  className="px-3 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white rounded-lg transition"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* DRIVE NOTES LIBRARY */}
          {currentView === 'drive-notes' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-teal-300">Google Drive Notes</p>
                  <h2 className="text-2xl font-bold text-white">{driveCurrentFolderId === driveRootFolderId ? 'Subjects' : driveBreadcrumbs.at(-1)?.name || 'Notes Library'}</h2>
                  {(driveCurrentSubject || driveCurrentTopic) && <p className="mt-1 text-sm text-slate-400">{[driveCurrentSubject, driveCurrentTopic].filter(Boolean).join(' / ')}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleRefreshDrive}
                    disabled={isDriveNotesLoading}
                    aria-label="Refresh Google Drive Notes Library"
                    title="Refresh"
                    className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 ${isDriveNotesLoading ? 'animate-spin' : ''}`} />
                  </button>
                  <button onClick={handleDriveBack} disabled={isDriveNotesLoading} className="flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-50">
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                </div>
              </div>

              {currentMember && (
                <section aria-label="Shared topic learning videos" className="space-y-4 border-b border-slate-800 pb-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-slate-100">Shared Topic Learning Videos</h3>
                      <p className="mt-1 text-xs text-slate-400">Add a YouTube link for this topic. Saved videos are shared with candidates preparing for the same exam.</p>
                    </div>
                  </div>

                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <label className="text-xs font-semibold text-slate-300">
                        Exam role
                        <select value={adminVideoContext.exam} onChange={(event) => { setIsLoadingAdminVideos(true); setAdminLearningVideos([]); setActiveLibraryVideo(null); setAdminVideoContext((previous) => ({ ...previous, exam: event.target.value })); setAdminVideoForm({ id: '', title: '', youtubeUrl: '' }); setAdminVideoDeleteId(''); setAdminVideoNotice(''); setAdminVideoError(''); }} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                          <option value="SI">SI</option>
                          <option value="CONSTABLE">Constable</option>
                        </select>
                      </label>
                      <label className="text-xs font-semibold text-slate-300">
                        Subject
                        <select value={adminVideoContext.subject} onChange={(event) => { const subject = event.target.value; setIsLoadingAdminVideos(true); setAdminLearningVideos([]); setActiveLibraryVideo(null); setAdminVideoContext((previous) => ({ ...previous, subject, topic: SUBJECT_TOPICS[subject]?.[0] || '' })); setAdminVideoForm({ id: '', title: '', youtubeUrl: '' }); setAdminVideoDeleteId(''); setAdminVideoNotice(''); setAdminVideoError(''); }} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                          {Object.keys(SUBJECT_TOPICS).map((subject) => <option key={subject} value={subject}>{subject}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-semibold text-slate-300">
                        Topic
                        <select value={adminVideoContext.topic} onChange={(event) => { setIsLoadingAdminVideos(true); setAdminLearningVideos([]); setActiveLibraryVideo(null); setAdminVideoContext((previous) => ({ ...previous, topic: event.target.value })); setAdminVideoForm({ id: '', title: '', youtubeUrl: '' }); setAdminVideoDeleteId(''); setAdminVideoNotice(''); setAdminVideoError(''); }} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                          {(SUBJECT_TOPICS[adminVideoContext.subject] || []).map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                        </select>
                      </label>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-slate-300">{adminLearningVideos.length} / 5 Videos</p>
                      {adminLearningVideos.length >= 5 && <p className="text-xs text-amber-200">Maximum 5 learning videos allowed for this topic.</p>}
                    </div>

                    {isLoadingAdminVideos ? <p role="status" className="text-xs text-slate-400">Loading Learning Videos...</p> : (
                      <ol className="divide-y divide-slate-800 rounded-md border border-slate-800">
                        {adminLearningVideos.map((video, index) => (
                          <li key={video.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <p className="text-xs font-bold text-slate-300">{index + 1}. {video.title}</p>
                              <p className="mt-1 truncate text-[11px] text-slate-500">{video.youtubeUrl}</p>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              <button type="button" onClick={() => setActiveLibraryVideo(video)} aria-label={`Play ${video.title} here`} className="inline-flex items-center gap-1.5 rounded-md border border-teal-500/40 px-2.5 py-1.5 text-xs font-semibold text-teal-100 hover:bg-teal-500/10"><Play className="h-3.5 w-3.5" />Play here</button>
                              <button type="button" onClick={() => { setAdminVideoForm({ id: video.id, title: video.title, youtubeUrl: video.youtubeUrl }); setAdminVideoError(''); setAdminVideoNotice(''); }} aria-label={`Edit ${video.title}`} title="Edit video" className="rounded-md border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"><Pencil className="h-4 w-4" /></button>
                              <button type="button" onClick={() => { setAdminVideoDeleteId(video.id); setAdminVideoError(''); setAdminVideoNotice(''); }} aria-label={`Delete ${video.title}`} title="Delete video" className="rounded-md border border-rose-500/30 p-2 text-rose-200 hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /></button>
                            </div>
                          </li>
                        ))}
                        {!adminLearningVideos.length && !isLoadingAdminVideos && <li className="p-3 text-xs text-slate-500">No learning videos added yet.</li>}
                      </ol>
                    )}

                    {activeLibraryVideo && adminLearningVideos.some((video) => video.id === activeLibraryVideo.id) && (
                      <YouTubeVideoPlayer video={activeLibraryVideo} onClose={() => setActiveLibraryVideo(null)} />
                    )}

                    {adminVideoDeleteId && (
                      <div className="flex flex-col gap-3 rounded-md border border-rose-500/30 bg-rose-950/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs text-rose-100">Are you sure you want to delete this learning video?</p>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => setAdminVideoDeleteId('')} disabled={isDeletingAdminVideo} className="rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 disabled:opacity-50">Cancel</button>
                          <button type="button" onClick={() => void handleDeleteAdminVideo()} disabled={isDeletingAdminVideo} className="rounded-md bg-rose-700 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-600 disabled:opacity-50">{isDeletingAdminVideo ? 'Deleting...' : 'Delete'}</button>
                        </div>
                      </div>
                    )}

                    <form onSubmit={handleSaveAdminVideo} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
                      <label className="text-xs font-semibold text-slate-300">
                        Video Title {adminVideoForm.id ? '' : '(optional)'}
                        <input value={adminVideoForm.title} onChange={(event) => setAdminVideoForm((previous) => ({ ...previous, title: event.target.value }))} maxLength={120} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="Percentages Basics" />
                      </label>
                      <label className="text-xs font-semibold text-slate-300">
                        YouTube URL
                        <input type="url" value={adminVideoForm.youtubeUrl} onChange={(event) => setAdminVideoForm((previous) => ({ ...previous, youtubeUrl: event.target.value }))} required className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="https://youtu.be/..." />
                      </label>
                      <button type="submit" disabled={isSavingAdminVideo || isLoadingAdminVideos || (!adminVideoForm.id && adminLearningVideos.length >= 5)} className="rounded-md bg-teal-700 px-4 py-2.5 text-xs font-bold text-white hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50">
                        {isSavingAdminVideo ? adminVideoForm.id ? 'Updating...' : 'Saving...' : adminVideoForm.id ? 'Update Video' : '+ Add YouTube Video'}
                      </button>
                      {adminVideoForm.id && <button type="button" onClick={() => setAdminVideoForm({ id: '', title: '', youtubeUrl: '' })} disabled={isSavingAdminVideo} className="text-left text-xs font-semibold text-slate-400 hover:text-white sm:col-span-3">Cancel edit</button>}
                    </form>
                    {adminVideoNotice && <p role="status" className="text-xs text-emerald-200">{adminVideoNotice}</p>}
                    {adminVideoError && <p role="alert" className="text-xs text-rose-200">{adminVideoError}</p>}
                  </>
                </section>
              )}

              {isDriveAdminStatusLoaded && (!(isGoogleDriveConnected && driveConnectionStatus === 'connected') || !isDriveAdminAuthorized) && (
                <section aria-label="Google Drive administration" className="border-b border-slate-800 pb-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-100">Drive administration</p>
                      <p className="mt-1 text-xs text-slate-400">
                        {!driveAdminAuthConfigured
                          ? 'Administrator access is not configured.'
                          : isDriveAdminAuthorized
                            ? isGoogleDriveConnected && driveConnectionStatus === 'connected'
                              ? 'Google Drive is connected.'
                              : driveConnectionStatus === 'checking'
                                ? 'Checking Google Drive connection.'
                                : driveConnectionStatus === 'error'
                                  ? 'Google Drive connection needs attention.'
                                  : 'Administrator access is active.'
                            : 'Administrator authorization is required to connect Google Drive.'}
                      </p>
                    </div>
                    {!driveAdminAuthConfigured ? null : isDriveAdminAuthorized ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleConnectGoogleDrive}
                          disabled={isDriveAuthStarting}
                          className="rounded-lg bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
                        >
                          {isDriveAuthStarting ? 'Opening Google...' : isGoogleDriveConnected ? 'Reconnect Google Drive' : 'Connect Google Drive'}
                        </button>
                        <button
                          type="button"
                          onClick={handleDriveAdminLogout}
                          aria-label="Lock Drive admin controls"
                          title="Lock Drive admin controls"
                          className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"
                        >
                          <Lock className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleDriveAdminLogin} className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
                        <label className="min-w-0 flex-1 text-xs font-semibold text-slate-300" htmlFor="drive-admin-key">
                          Site administrator only: Notes Library key
                          <input
                            id="drive-admin-key"
                            type="password"
                            autoComplete="current-password"
                            value={driveAdminKey}
                            onChange={(event) => setDriveAdminKey(event.target.value)}
                            className="mt-1 w-full rounded-md border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-teal-500"
                          />
                        </label>
                        <p className="text-xs text-slate-400 sm:max-w-56">Candidates can browse the shared Notes Library without this key.</p>
                        <button
                          type="submit"
                          disabled={!driveAdminKey || isDriveAdminLoggingIn}
                          className="rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-600 disabled:opacity-50"
                        >
                          {isDriveAdminLoggingIn ? 'Verifying...' : 'Unlock management'}
                        </button>
                      </form>
                    )}
                  </div>
                  {driveAdminError && <p role="alert" className="mt-2 text-xs text-rose-300">{driveAdminError}</p>}
                </section>
              )}

              <nav aria-label="Google Drive breadcrumbs" className="flex flex-wrap items-center gap-1 text-sm">
                {driveBreadcrumbs.map((crumb, index) => (
                  <div key={crumb.id} className="flex items-center gap-1">
                    {index > 0 && <ChevronRight className="h-4 w-4 text-slate-600" />}
                    <button
                      onClick={() => handleDriveBreadcrumbClick(index)}
                      disabled={isDriveNotesLoading || index === driveBreadcrumbs.length - 1}
                      className={`rounded px-1.5 py-1 ${index === driveBreadcrumbs.length - 1 ? 'font-semibold text-white' : 'text-teal-300 hover:bg-slate-800'} disabled:cursor-default disabled:opacity-100`}
                    >
                      {crumb.name}
                    </button>
                  </div>
                ))}
              </nav>

              {driveBreadcrumbs.length === 3 && driveCurrentFolderId === driveBreadcrumbs[2]?.id && (
                <section aria-label="Share a note with candidates" className="border-b border-slate-800 pb-4">
                  <label className="block text-sm font-semibold text-slate-200" htmlFor="candidate-drive-upload">
                    Share a note with candidates
                    <input
                      id="candidate-drive-upload"
                      type="file"
                      accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.png,.jpg,.jpeg,.webp"
                      disabled={isDriveUploading || isDriveNotesLoading}
                      onChange={handleCandidateDriveUpload}
                      className="mt-2 block w-full text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-teal-700 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-teal-600 disabled:opacity-50"
                    />
                  </label>
                  <p className="mt-2 text-xs text-slate-400">Published immediately in this topic for other candidates. PDF, Office documents, TXT, PNG, JPG, or WebP; up to 20 MB.</p>
                  {isDriveUploading && <p role="status" className="mt-2 text-xs text-slate-300">Uploading note...</p>}
                  {driveUploadMessage && <p role="status" className="mt-2 text-xs text-teal-200">{driveUploadMessage}</p>}
                </section>
              )}

              {isDriveNotesLoading && <p role="status" className="text-sm text-slate-300">Loading notes...</p>}
              {driveNotesError && (
                <p role="status" className="text-sm text-slate-400">{driveNotesError}</p>
              )}
              {(!isGoogleDriveConnected || driveConnectionStatus !== 'connected') && (
                <p className="text-sm text-slate-400">Connect your Google account to open the Notes Library.</p>
              )}

              {!isDriveNotesLoading && !driveNotesError && driveCurrentFolders.length > 0 && (
                <section aria-label={driveBreadcrumbs.length === 1 ? 'Subjects' : 'Topics and folders'} className="space-y-3">
                  <h3 className="text-sm font-bold text-slate-200">{driveBreadcrumbs.length === 1 ? 'Subjects' : 'Topics'}</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {driveCurrentFolders.map((folder) => (
                      <button
                        key={folder.id}
                        onClick={() => handleOpenDriveFolder(folder)}
                        className="flex items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800 p-4 text-left hover:border-teal-500 hover:bg-slate-800/80"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <Folder className="h-5 w-5 shrink-0 text-teal-300" />
                          <span className="truncate font-semibold text-slate-100">{folder.name}</span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {!isDriveNotesLoading && !driveNotesError && driveCurrentFiles.length > 0 && (
                <section className="space-y-3" aria-label="Google Drive files">
                  <h3 className="text-sm font-bold text-slate-200">{driveCurrentFiles.length} files</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {driveCurrentFiles.map((file) => {
                      return (
                        <article key={file.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 p-2 hover:border-teal-500/70">
                          <button type="button" onClick={() => handleOpenDriveFile(file)} className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left">
                            <FileText className="h-5 w-5 shrink-0 text-teal-300" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-semibold text-slate-100">{file.name}</span>
                              <span className="mt-1 block truncate text-xs text-slate-400">{file.mimeType}</span>
                              {file.modifiedTime && <span className="mt-1 block text-xs text-slate-500">Modified {new Date(file.modifiedTime).toLocaleDateString()}</span>}
                            </span>
                            <span className="shrink-0 text-xs font-semibold text-teal-300">View</span>
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}

              {!isDriveNotesLoading && !driveNotesError && driveBreadcrumbs.length >= 3 && !driveCurrentFiles.length && (
                <div className="rounded-lg border border-dashed border-slate-600 bg-slate-800 p-8 text-center">
                  <BookOpen className="mx-auto mb-3 h-8 w-8 text-slate-500" />
                  <p className="text-sm text-slate-300">No notes available for this topic yet.</p>
                </div>
              )}

              {!isDriveNotesLoading && !driveNotesError && driveBreadcrumbs.length === 1 && !driveCurrentFolders.length && !driveCurrentFiles.length && (
                <p className="py-4 text-sm text-slate-400">No folders or files in this folder.</p>
              )}

              {drivePreviewFile && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-6" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDrivePreviewFile(null)}>
                  <section
                    ref={drivePreviewContainerRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="drive-preview-title"
                    className={`flex w-full flex-col overflow-hidden border border-slate-700 bg-slate-900 shadow-2xl ${isDrivePreviewFullscreen ? 'h-screen max-h-screen max-w-none rounded-none border-0' : 'h-[88vh] max-h-[92vh] max-w-5xl rounded-lg'}`}
                  >
                    <header className="flex items-center gap-3 border-b border-slate-700 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <h3 id="drive-preview-title" className="truncate text-sm font-bold text-white">{drivePreviewFile.name}</h3>
                        <p className="mt-0.5 truncate text-xs text-slate-400">{fileMimeLabel(drivePreviewFile.mimeType)}</p>
                      </div>
                      <a href={drivePreviewFile.downloadUrl} download={drivePreviewFile.name} className="inline-flex items-center gap-2 rounded-md bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-500">
                        <Download className="h-4 w-4" />
                        Download
                      </a>
                      <button
                        onClick={handleToggleDrivePreviewFullscreen}
                        aria-label={isDrivePreviewFullscreen ? 'Exit full screen' : 'View full screen'}
                        title={isDrivePreviewFullscreen ? 'Exit full screen' : 'View full screen'}
                        className="rounded-md p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
                      >
                        {isDrivePreviewFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                      </button>
                      <button onClick={() => setDrivePreviewFile(null)} aria-label="Close file preview" className="rounded-md p-2 text-slate-300 hover:bg-slate-800 hover:text-white">
                        <X className="h-4 w-4" />
                      </button>
                    </header>
                    {isDriveBrowserPreviewable(drivePreviewFile.mimeType) ? (
                      <iframe title={`Preview: ${drivePreviewFile.name}`} src={drivePreviewFile.contentUrl} className="min-h-0 flex-1 bg-slate-950" />
                    ) : (
                      <div className="flex min-h-72 flex-col items-center justify-center gap-3 p-8 text-center">
                        <FileText className="h-10 w-10 text-slate-500" />
                        <p className="text-sm font-semibold text-slate-200">This document format cannot be previewed in the browser.</p>
                        <p className="text-xs text-slate-400">Download it here without leaving the Notes Library.</p>
                      </div>
                    )}
                  </section>
                </div>
              )}
            </div>
          )}

          {/* AI TUTOR VIEW */}
          {currentView === 'ai-tutor' && (
            <div className="max-w-4xl mx-auto h-[calc(100vh-140px)] flex flex-col bg-slate-800 border border-slate-700 rounded-2xl shadow-xl overflow-hidden">
              <div className="bg-slate-900 px-6 py-4 border-b border-slate-700 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-indigo-600/30 rounded-xl border border-indigo-500/40 text-indigo-400">
                    <Brain className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-md">TS Police AI Exam Guru</h3>
                    <p className="text-xs text-slate-400">Ask any concept, formula shortcut, or Telangana Movement detail</p>
                  </div>
                </div>
                <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold rounded-full">
                  Online
                </span>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {!chatMessages.length && !isChatLoading && <p className="text-center text-xs text-slate-500">Start a conversation with the AI tutor.</p>}
                {chatMessages.map((msg, idx) => (
                  <div key={idx} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-lg p-4 rounded-2xl text-xs sm:text-sm leading-relaxed whitespace-pre-line ${msg.sender === 'user' ? 'bg-blue-600 text-white rounded-br-none shadow' : 'bg-slate-900 border border-slate-700 text-slate-200 rounded-bl-none shadow-md'
                      }`}>
                      {msg.text}
                    </div>
                  </div>
                ))}
                {isChatLoading && <p className="text-xs text-slate-400">AI Exam Guru is thinking...</p>}
              </div>

              <div className="p-4 bg-slate-900 border-t border-slate-700 flex space-x-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !isChatLoading && handleSendChatMessage()}
                  placeholder="Ask a doubt (e.g. Percentage formulas, Gentlemen's agreement...)"
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-xs sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleSendChatMessage}
                  disabled={isChatLoading}
                  className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow"
                >
                  {isChatLoading ? '...' : <Send className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}

          {/* USER PROFILE & HISTORY VIEW */}
          {currentView === 'profile' && (
            <div id="profile-report" className="max-w-4xl mx-auto space-y-6">
              <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-xl flex items-center space-x-4">
                <div className="w-16 h-16 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-full flex items-center justify-center text-white font-black text-xl shadow-lg">
                  {currentMember.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">{currentMember.name}</h3>
                  <p className="text-xs text-slate-400">{currentMember.email} · Targeting: Telangana {selectedExam}</p>
                </div>
              </div>

              <section aria-labelledby="developer-details-heading" className="overflow-hidden rounded-2xl border border-teal-500/20 bg-gradient-to-br from-slate-800 via-slate-800 to-teal-950/40 p-6 shadow-xl">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-300">About this platform</p>
                    <h3 id="developer-details-heading" className="mt-2 text-xl font-bold text-white">Developer Details</h3>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
                      Beepali Srikanth builds tools to help Telangana Police SI and Constable candidates prepare with AI-powered practice, personalized study schedules, and topic-wise revision.
                    </p>
                    <p className="mt-3 inline-flex rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-200">
                      This website is part of sriXplore.
                    </p>
                  </div>
                  <a
                    href="https://my-portfolio-v0ez.onrender.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center justify-center rounded-lg border border-teal-400/30 bg-teal-500/10 px-4 py-2.5 text-sm font-bold text-teal-200 transition hover:bg-teal-500/20"
                  >
                    Visit Portfolio
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </div>
                <dl className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-4">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">Name</dt>
                    <dd className="mt-1 text-sm font-bold text-white">Beepali Srikanth</dd>
                  </div>
                  <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-4">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">Email</dt>
                    <dd className="mt-1 text-sm font-bold">
                      <a href="mailto:beepalisrikanth@gmail.com" className="break-all text-blue-300 hover:text-blue-200">beepalisrikanth@gmail.com</a>
                    </dd>
                  </div>
                  <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-4">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">Contact</dt>
                    <dd className="mt-1 text-sm font-bold">
                      <a href="tel:+919502993964" className="text-blue-300 hover:text-blue-200">+91 9502993964</a>
                    </dd>
                  </div>
                  <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-4">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">Portfolio</dt>
                    <dd className="mt-1 text-sm font-bold">
                      <a href="https://my-portfolio-v0ez.onrender.com/" target="_blank" rel="noopener noreferrer" className="break-all text-blue-300 hover:text-blue-200">
                        Beepalisrikanth
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </dd>
                  </div>
                </dl>
                <p className="mt-4 border-t border-slate-700/70 pt-4 text-xs text-slate-400">
                  TS Police AI Prep · Telangana SI &amp; Constable exam preparation
                </p>
              </section>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <p className="text-xs text-slate-400">Total Attempts</p>
                  <p className="text-2xl font-black text-white mt-1">{selectedExamHistory.length}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <p className="text-xs text-slate-400">Best Marks</p>
                  <p className="text-2xl font-black text-emerald-400 mt-1">{bestExamAttempt ? `${bestExamAttempt.score}/${bestExamAttempt.total || 10}` : '0/0'}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <p className="text-xs text-slate-400">Average Accuracy</p>
                  <p className="text-2xl font-black text-blue-400 mt-1">{selectedExamHistory.length ? Math.round(selectedExamHistory.reduce((sum, attempt) => sum + attempt.accuracy, 0) / selectedExamHistory.length) : 0}%</p>
                </div>
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <p className="text-xs text-slate-400">Questions Practiced</p>
                  <p className="text-2xl font-black text-amber-400 mt-1">{selectedExamQuestionCount}</p>
                </div>
              </div>

              <section aria-label="Progress report tools" className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5 shadow-xl print:hidden">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-bold text-white">Your preparation tools</h3>
                    <p className="mt-1 text-xs text-slate-400">Export your {selectedExam} progress, print this report, or start a timed simulation.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => downloadProgressReport('csv')} className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-bold text-slate-100 hover:bg-slate-700">Download CSV</button>
                    <button type="button" onClick={() => downloadProgressReport('json')} className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-bold text-slate-100 hover:bg-slate-700">Download JSON</button>
                    <button type="button" onClick={() => window.print()} className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-100 hover:bg-blue-500/20">Print report</button>
                    <button type="button" onClick={() => { setRevisionMockMode('exam-day'); setRevisionMockQuestionCount(120); setRevisionMockDurationMinutes(120); setCurrentView('revision-mock'); }} disabled={!selectedExamProgress.length} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50">Exam-day simulation</button>
                  </div>
                </div>
              </section>

              <section aria-labelledby="revision-reminders-heading" className="rounded-2xl border border-amber-500/20 bg-slate-800/80 p-5 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-300">Adaptive reminders</p>
                    <h3 id="revision-reminders-heading" className="mt-1 text-lg font-bold text-white">Spaced revision plan</h3>
                  </div>
                  <span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-100">{spacedRevisionRecommendations.filter((item) => item.daysUntilDue <= 0).length} due now</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-400">Review intervals adapt to your latest topic accuracy: weaker topics return sooner, while stronger topics are spaced further apart.</p>
                {spacedRevisionRecommendations.length ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {spacedRevisionRecommendations.map((item) => (
                      <div key={`${item.subject}:${item.topic}`} className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-bold text-white">{item.subject} · {item.topic}</p>
                          <p className="mt-1 text-[11px] text-slate-400">{item.accuracy}% latest accuracy · {item.intervalDays}-day interval · due {item.dueAt}</p>
                        </div>
                        <button type="button" onClick={() => handlePracticeTopic(item.subject, item.topic)} className="shrink-0 rounded-lg border border-amber-400/30 px-2.5 py-1.5 text-[10px] font-bold text-amber-100 hover:bg-amber-500/10">Revise</button>
                      </div>
                    ))}
                  </div>
                ) : <p className="mt-4 text-sm text-slate-400">Complete a topic test to get your first personalized revision reminder.</p>}
              </section>

              <section aria-labelledby="mistake-notebook-heading" className="rounded-2xl border border-rose-500/20 bg-slate-800/80 p-5 shadow-xl">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-rose-300">Learn from review</p>
                    <h3 id="mistake-notebook-heading" className="mt-1 text-lg font-bold text-white">Mistake notebook</h3>
                  </div>
                  <span className="rounded-full bg-rose-500/10 px-3 py-1 text-xs font-bold text-rose-200">{mistakeNotebook.length} items</span>
                </div>
                {mistakeNotebook.length ? (
                  <div aria-label="Mistake notebook entries" className="mt-4 max-h-[32rem] space-y-2 overflow-y-auto overscroll-contain pr-2" role="region" tabIndex={0}>
                    {mistakeNotebook.map((item, index) => (
                      <div key={`${item.attemptId}:${item.id || index}`} className="flex flex-col gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold leading-5 text-slate-100">{item.question || 'Question details unavailable'}</p>
                          <p className="mt-1 text-[11px] text-slate-400">{item.subject} · {item.topic} · {item.answerStatus} · {item.date}</p>
                          <p className="mt-1 text-[11px] text-emerald-200">Correct answer: {item.correctAnswer || 'Not recorded'}</p>
                          <p className="mt-2 text-xs leading-5 text-slate-300"><span className="font-bold text-blue-300">Explanation:</span> {item.explanation || 'Explanation not recorded for this question.'}</p>
                        </div>
                        {item.topic && <button type="button" onClick={() => handlePracticeTopic(item.subject, item.topic)} className="shrink-0 rounded-lg border border-rose-400/30 px-2.5 py-1.5 text-[10px] font-bold text-rose-100 hover:bg-rose-500/10">Practice now</button>}
                      </div>
                    ))}
                  </div>
                ) : <p className="mt-4 text-sm text-slate-400">Incorrect and unanswered questions from your completed tests will appear here.</p>}
              </section>

              <section aria-labelledby="test-insights-heading" className="rounded-2xl border border-blue-500/20 bg-slate-800/80 p-5 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">Performance analytics</p>
                    <h3 id="test-insights-heading" className="mt-1 text-lg font-bold text-white">Mock-test insights</h3>
                  </div>
                  {mockTestInsights.recent.length > 0 && <p className="text-xs text-slate-300">Average pace: <strong className="text-blue-200">{Math.round(mockTestInsights.recent.reduce((sum, item) => sum + item.averageSecondsPerQuestion, 0) / mockTestInsights.recent.length)} sec/question</strong></p>}
                </div>
                {mockTestInsights.recent.length ? (
                  <div className="mt-4 space-y-3">
                    <div className="flex flex-wrap gap-3 text-xs">
                      <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-emerald-100">Strongest: {mockTestInsights.strongest ? `${mockTestInsights.strongest.topic} (${mockTestInsights.strongest.accuracy}%)` : 'Not enough topic data'}</p>
                      <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-amber-100">Needs work: {mockTestInsights.needsWork ? `${mockTestInsights.needsWork.topic} (${mockTestInsights.needsWork.accuracy}%)` : 'Not enough topic data'}</p>
                    </div>
                    <div className="space-y-2">
                      {mockTestInsights.recent.map((item) => (
                        <div key={`${item.name}:${item.date}`} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 text-xs">
                          <span className="text-slate-400">{item.date || item.name}</span>
                          <div className="h-2 overflow-hidden rounded-full bg-slate-700" role="img" aria-label={`${item.accuracy}% accuracy`}>
                            <div className={`h-full rounded-full ${item.accuracy >= 70 ? 'bg-emerald-500' : item.accuracy >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${Math.min(100, Math.max(0, item.accuracy))}%` }} />
                          </div>
                          <span className="font-bold text-slate-200">{item.accuracy}% · {item.averageSecondsPerQuestion}s/q</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <p className="mt-4 text-sm text-slate-400">Complete tests to see accuracy trends, topic strengths, and your average time per question.</p>}
              </section>

              <section aria-labelledby="saved-questions-heading" className="rounded-2xl border border-teal-500/20 bg-slate-800/80 p-5 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-300">Build a custom test</p>
                    <h3 id="saved-questions-heading" className="mt-1 text-lg font-bold text-white">Saved questions</h3>
                  </div>
                  <span className="rounded-full bg-teal-500/10 px-3 py-1 text-xs font-bold text-teal-100">{selectedExamBookmarks.length} saved</span>
                </div>
                {accountDataError && <p role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{accountDataError}</p>}
                {selectedExamBookmarks.length ? (
                  <>
                    <div className="mt-4 space-y-2">
                      {selectedExamBookmarks.map((item) => (
                        <div key={item.id} className="flex items-start gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                          <input aria-label={`Select saved question: ${item.question}`} type="checkbox" checked={selectedBookmarkIds.includes(item.id)} onChange={(event) => setSelectedBookmarkIds((previous) => event.target.checked ? [...new Set([...previous, item.id])] : previous.filter((id) => id !== item.id))} className="mt-1 accent-teal-500" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-semibold leading-5 text-slate-100">{item.question}</span>
                            <span className="mt-1 block text-[11px] text-slate-400">{item.subject} · {item.topic}</span>
                          </span>
                          <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void handleToggleBookmark(item, { exam: item.exam, subject: item.subject, topic: item.topic, difficulty: item.difficulty }); }} disabled={isSavingBookmarks} className="shrink-0 text-[10px] font-bold text-rose-300 hover:text-rose-200 disabled:opacity-50">Remove</button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                      <label className="text-xs font-semibold text-slate-300">Practice duration
                        <select value={bookmarkPracticeDuration} onChange={(event) => setBookmarkPracticeDuration(Number(event.target.value))} className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                          {[10, 20, 30, 40, 50, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
                        </select>
                      </label>
                      <button type="button" onClick={() => void handleStartBookmarkedPractice()} disabled={!selectedBookmarkIds.length || isGeneratingQuestions} className="rounded-lg bg-teal-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-teal-500 disabled:opacity-50">
                        {isGeneratingQuestions ? 'Preparing…' : `Practice selected (${selectedBookmarkIds.length})`}
                      </button>
                    </div>
                    {questionGenerationError && <p role="alert" className="mt-3 text-xs text-rose-200">{questionGenerationError}</p>}
                  </>
                ) : <p className="mt-4 text-sm text-slate-400">Save questions from a test review to build a personal practice set.</p>}
              </section>

              <section aria-labelledby="accessibility-heading" className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5 shadow-xl print:hidden">
                <h3 id="accessibility-heading" className="text-lg font-bold text-white">Accessibility & language</h3>
                <div className="mt-4 flex flex-wrap items-center gap-4">
                  <label className="text-xs font-semibold text-slate-300">Text size
                    <select value={textScale} onChange={(event) => setTextScale(event.target.value)} className="ml-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                      <option value="16px">Standard</option>
                      <option value="18px">Large</option>
                      <option value="20px">Extra large</option>
                    </select>
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-300">
                    <input type="checkbox" checked={highContrast} onChange={(event) => setHighContrast(event.target.checked)} className="accent-teal-500" />
                    High contrast
                  </label>
                </div>

                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Theme</span>
                    <span className="text-[10px] text-slate-500">{THEME_OPTIONS.find((option) => option.id === activeTheme)?.label || 'Midnight'}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {THEME_OPTIONS.map((option) => {
                      const selected = option.id === activeTheme;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-label={`Select ${option.label} theme`}
                          aria-pressed={selected}
                          onClick={() => setActiveTheme(option.id)}
                          className={`relative flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${selected ? 'border-white/70 bg-white/10 text-white shadow-lg' : 'border-slate-600 bg-slate-900/70 text-slate-300 hover:border-slate-500 hover:text-white'}`}
                        >
                          <span className="block h-3.5 w-3.5 rounded-full border border-white/30" style={{ background: option.swatch }} />
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <p className="mt-3 text-xs text-slate-400">Display preferences stay in this browser. Telugu explanations are available beside reviewed questions.</p>
              </section>

              <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-xl space-y-4">
                <h3 className="text-lg font-bold text-white">Attempt Log</h3>
                {!selectedExamHistory.length && <p className="text-sm text-slate-400">No tests completed yet. Start a topic test to build your member history.</p>}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-900 text-slate-400 uppercase font-semibold">
                      <tr>
                        <th className="p-3">Topic</th>
                        <th className="p-3">Level</th>
                        <th className="p-3">Score</th>
                        <th className="p-3">Accuracy</th>
                        <th className="p-3">Status</th>
                        <th className="p-3">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/60">
                      {selectedExamHistory.map((att) => (
                        <tr key={att.id} className="hover:bg-slate-700/30 transition">
                          <td className="p-3 font-semibold text-slate-100">
                            <button onClick={() => handleViewAttempt(att)} className="text-left text-blue-300 hover:text-blue-200 underline underline-offset-2">
                              {att.mode === 'exam-day' ? 'Exam-day simulation' : att.mode === 'bookmark-practice' ? 'Saved-question practice' : att.mode === 'revision-mock' ? 'Revision mock' : att.topic}
                            </button>
                          </td>
                          <td className="p-3">{att.difficulty}</td>
                          <td className="p-3 font-bold text-blue-400">{att.score}/{att.total || 10}</td>
                          <td className="p-3">{att.accuracy}%</td>
                          <td className="p-3">
                            <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${att.status === 'LEVEL PASSED' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                              }`}>
                              {att.status}
                            </span>
                          </td>
                          <td className="p-3 text-slate-400">{att.date || att.submittedAt?.slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* SUBMIT CONFIRMATION MODAL */}
      {isSubmitModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="text-lg font-bold text-white">Confirm Submission</h3>
            <p className="text-xs text-slate-300">
              Answered: <span className="text-blue-400 font-bold">{activeAnswerCount} / {activeTestQuestions.length}</span>
              <span className="mx-2 text-slate-500">·</span>
              Unanswered: <span className="text-amber-300 font-bold">{Math.max(0, activeTestQuestions.length - activeAnswerCount)}</span>
            </p>
            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => setIsSubmitModalOpen(false)}
                className="flex-1 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-xl transition"
              >
                Resume
              </button>
              <button
                onClick={handleFinalSubmitTest}
                disabled={isSubmittingTest}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow transition disabled:opacity-50"
              >
                {isSubmittingTest ? 'Submitting...' : 'Submit Now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI DEEP SOLUTION MODAL */}
      {aiModalContent && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-slate-700 pb-2">
              <h3 className="text-md font-bold text-indigo-400 flex items-center space-x-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>AI Guru Detailed Breakdown</span>
              </h3>
              <button onClick={() => setAiModalContent(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="text-xs text-slate-200 whitespace-pre-line leading-relaxed">
              {aiModalContent}
            </div>
          </div>
        </div>
      )}

      {/* ENGINE SPECS MODAL */}
      {showDevModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <Code className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-white text-base">AI Question System</h3>
              </div>
              <button onClick={() => setShowDevModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="text-xs text-slate-300 space-y-2 leading-relaxed">
              <p><strong>Gemini Generation:</strong> Sends the selected exam, subject, topic, difficulty, and attempt number to the Gemini question server.</p>
              <p><strong>AI Validation:</strong> The server and browser verify exactly 10 topic-specific questions, four unique options, matching answers, explanations, and distinct question models before the test opens.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}