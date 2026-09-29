import React, { useState, useEffect, useMemo, useEffectEvent, useRef } from 'react';
import {
  BookOpen, Folder, FolderPlus, Upload, Download, FileText, Target, Clock, ChevronRight, BarChart2, User, Sparkles,
  ArrowLeft, Send, ShieldAlert, Play, X, Maximize2, Minimize2, Brain, Lock, Unlock, RotateCcw, Code, LogOut, Mail, KeyRound, UserPlus,
  Volume2, VolumeX, CalendarDays
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell
} from 'recharts';
import { generateQuestions, generateNotes, sendChatMessage, getDriveStatus, getDriveFolder, provisionDriveFolders, uploadDriveFile, getDriveAuthUrl, checkDriveConnection, disconnectDrive, getDriveFileContentUrl } from './services/aiService.js';
import { calculateTestResult, normalizeAnswer } from './test-results.js';
import {
  buildPlannerSnapshot,
  getPriorityColorClass,
  getProgressColorClass,
  getStatusColorClass,
  resolveTopicWeightage
} from './planner-utils.js';

// Syllabus Configuration
const SUBJECT_TOPICS = {
  "Arithmetic": [
    "Percentages", "Profit and Loss", "Simple & Compound Interest",
    "Time and Work", "Time, Speed and Distance", "Ratio and Proportion",
    "Average", "Number System & Simplification", "Mixtures and Allegation",
    "Problems on Ages", "Boats and Streams", "Data Interpretation", "Partnership",
    "Pipes and Cisterns", "Time and Distance", "HCF and LCM", "Fractions and Decimals",
    "Number Series", "Mensuration", "Algebra Basics", "Geometry Basics", "Probability Basics",
    "Permutation and Combination", "Simplification by BODMAS", "Surds and Indices", "Square Roots"
  ],
  "Reasoning": [
    "Coding-Decoding", "Number Series", "Direction Sense",
    "Analogy", "Blood Relations", "Syllogisms", "Seating Arrangement",
    "Venn Diagrams", "Non-Verbal Reasoning", "Data Sufficiency", "Calendar and Clock",
    "Classification", "Odd One Out", "Statement and Conclusions", "Decision Making",
    "Mathematical Operations", "Logical Sequence", "Missing Number", "Statement and Arguments",
    "Cause and Effect", "Course of Action", "Input-Output", "Puzzle Test", "Figure Matrix",
    "Mirror and Water Images", "Paper Folding and Cutting"
  ],
  "General Studies": [
    "Indian Polity", "Indian History", "Indian Geography", "General Science",
    "Indian Economy", "Environment and Ecology", "Science and Technology", "Current Affairs",
    "Indian Constitution", "Fundamental Rights and Duties", "Union and State Government",
    "Local Governance and Panchayati Raj", "Modern Indian History", "Indian National Movement",
    "Physical Geography", "Indian Rivers and Resources", "Banking and Budget",
    "Awards, Sports and Important Days", "Parliament and Judiciary", "Constitutional Bodies",
    "Election System", "Public Policy and Welfare", "Disaster Management", "Climate and Weather",
    "Agriculture and Food Security", "Population and Census", "International Relations",
    "Computer Awareness and Cyber Security"
  ],
  "Telangana GK": [
    "Telangana Formation", "Telangana History & Movement",
    "Telangana Schemes & Projects", "Telangana Culture & Geography", "Telangana Districts",
    "Telangana Rivers and Irrigation", "Telangana Festivals and Literature", "State Administration",
    "Kakatiya Dynasty", "Qutb Shahi Dynasty", "Asaf Jahi History", "Telangana Archaeology",
    "Telangana Art and Handicrafts", "Telangana Tribes and Folk Traditions", "Telangana Economy",
    "Telangana Agriculture and Industries", "Telangana Welfare Schemes", "Telangana Census and Statistics",
    "Telangana State Symbols", "Telangana Public Service and Administration", "Telangana Urban Development",
    "Telangana Irrigation Projects", "Telangana Power Projects", "Telangana Flora and Fauna",
    "Telangana Important Personalities", "Telangana Literature and Authors"
  ],
  "English": [
    "Grammar & Prepositions", "Vocabulary & Synonyms", "Sentences", "Sentence Correction",
    "Error Spotting", "Active and Passive Voice", "Direct and Indirect Speech", "Reading Comprehension",
    "Parts of Speech", "Tenses", "Articles and Conjunctions", "Idioms and Phrases",
    "Antonyms and One Word Substitution", "Spelling", "Cloze Test", "Subject-Verb Agreement",
    "Modals and Auxiliaries", "Adverbs and Adjectives", "Punctuation", "Para Jumbles",
    "Sentence Rearrangement", "Fill in the Blanks", "Commonly Confused Words"
  ]
};

const HIGH_WEIGHTAGE_TOPICS = {
  Arithmetic: [
    "Percentages", "Profit and Loss", "Time and Work", "Time, Speed and Distance",
    "Ratio and Proportion", "Average", "Number System & Simplification", "Data Interpretation"
  ],
  Reasoning: [
    "Coding-Decoding", "Number Series", "Direction Sense", "Blood Relations",
    "Syllogisms", "Seating Arrangement", "Puzzles", "Input-Output"
  ],
  "General Studies": [
    "Indian Polity", "Indian History", "Indian Geography", "General Science",
    "Indian Economy", "Environment and Ecology", "Current Affairs", "Indian Constitution"
  ],
  "Telangana GK": [
    "Telangana Formation", "Telangana History & Movement", "Telangana Schemes & Projects",
    "Telangana Culture & Geography", "Telangana Districts", "Telangana Rivers and Irrigation"
  ],
  English: [
    "Grammar & Prepositions", "Vocabulary & Synonyms", "Sentence Correction", "Error Spotting",
    "Reading Comprehension", "Cloze Test", "Subject-Verb Agreement"
  ]
};

const getTopicWeightage = (subject, topic) => {
  const isHighWeightage = HIGH_WEIGHTAGE_TOPICS[subject]?.includes(topic);
  return {
    range: isHighWeightage ? "2-3 questions" : "1-2 questions",
    priority: isHighWeightage ? "High focus" : "Regular focus"
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
const MEMBERS_STORAGE_KEY = 'ts-police-ai-members-v1';
const ACTIVE_MEMBER_STORAGE_KEY = 'ts-police-ai-active-member-v1';
const LEGACY_ACTIVE_MEMBER_STORAGE_KEY = 'ts-police-ai-active-member-email-v1';
const PLANNER_STORAGE_KEY = 'ts-police-smart-planner-v1';
const UPCOMING_EXAMS = [
  { id: 'si', name: 'TS SI / SI-equivalent', date: '29 November 2026', weekday: 'Sunday', targetTime: Date.parse('2026-11-29T00:00:00+05:30') },
  { id: 'constable', name: 'TS Constable / PC-equivalent', date: '20 December 2026', weekday: 'Sunday', targetTime: Date.parse('2026-12-20T00:00:00+05:30') }
];
const isDriveBrowserPreviewable = (mimeType) => mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType.startsWith('image/');
const fileMimeLabel = (mimeType) => mimeType === 'application/vnd.google-apps.document' ? 'Google document · PDF preview' : mimeType;

const getExamCountdown = (targetTime, now) => {
  const remainingMinutes = Math.max(0, Math.floor((targetTime - now) / 60_000));
  return {
    days: Math.floor(remainingMinutes / 1440),
    hours: Math.floor((remainingMinutes % 1440) / 60),
    minutes: remainingMinutes % 60,
    isPast: targetTime <= now
  };
};

const createMemberId = () => `member_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const normalizeExamForRequest = (exam) => {
  if (exam === 'SI') return 'TS SI';
  if (exam === 'CONSTABLE') return 'TS Constable';
  return exam;
};

const readStoredMembers = () => {
  try {
    const raw = localStorage.getItem(MEMBERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const readActiveMember = () => {
  if (typeof window === 'undefined') return null;
  const members = readStoredMembers();
  const activeMemberId = localStorage.getItem(ACTIVE_MEMBER_STORAGE_KEY);
  if (activeMemberId && members[activeMemberId]) return members[activeMemberId];
  const activeEmail = localStorage.getItem(LEGACY_ACTIVE_MEMBER_STORAGE_KEY) || localStorage.getItem(ACTIVE_MEMBER_STORAGE_KEY);
  if (activeEmail && members[activeEmail]) return members[activeEmail];
  const fallbackMember = Object.values(members).find((member) => member && member.email && member.email === activeEmail);
  return fallbackMember || null;
};

const createEmptyMemberData = (name, email, exam = 'SI') => ({
  id: createMemberId(),
  name,
  email,
  exam,
  userProgress: {},
  testHistory: [],
  seenQuestionCount: 0,
  testAttemptCounter: 0,
  plannerData: {
    examType: exam,
    generatedAt: null,
    summary: {},
    topicMetrics: [],
    schedule: []
  }
});

const createEmptyPlannerState = (member = null) => ({
  examType: member?.exam || 'SI',
  generatedAt: null,
  summary: {},
  topicMetrics: [],
  schedule: []
});

const hashPassword = async (password, salt) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const createPasswordSalt = () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { bytes: salt, encoded: Array.from(salt, (byte) => byte.toString(16).padStart(2, '0')).join('') };
};

const decodePasswordSalt = (encoded) => new Uint8Array(encoded.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)));

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
  const initialMember = readActiveMember();
  const [currentMember, setCurrentMember] = useState(initialMember);
  const [plannerData, setPlannerData] = useState(() => initialMember?.plannerData || createEmptyPlannerState(initialMember));
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
  const [isMemberHydrated] = useState(true);

  // Application View Navigation
  const [currentView, setCurrentView] = useState(initialMember ? 'dashboard' : 'login'); // 'login', 'signup', 'dashboard', 'topics', 'topic-detail', 'test', 'result', 'ai-tutor', 'profile'
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [selectedExam, setSelectedExam] = useState(initialMember?.exam || 'SI'); // 'SI' or 'CONSTABLE'
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [selectedSubject, setSelectedSubject] = useState('');
  const [selectedTopic, setSelectedTopic] = useState('');
  const [showStudyNotes, setShowStudyNotes] = useState(false);
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

  useEffect(() => {
    const interval = setInterval(() => setCountdownNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Global Counter for guaranteed fresh attempt seeds
  const [testAttemptCounter, setTestAttemptCounter] = useState(initialMember?.testAttemptCounter || 1);
  const [seenQuestionCount, setSeenQuestionCount] = useState(initialMember?.seenQuestionCount || 20);

  // User Progression State
  const [userProgress, setUserProgress] = useState(() => initialMember?.userProgress || {});
  const [testHistory, setTestHistory] = useState(() => initialMember?.testHistory || []);

  // Active Test Engine States
  const [activeTestQuestions, setActiveTestQuestions] = useState([]);
  const [userAnswers, setUserAnswers] = useState({});
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(600); // 10 minutes
  const [isSubmitModalOpen, setIsSubmitModalOpen] = useState(false);
  const [isSubmittingTest, setIsSubmittingTest] = useState(false);
  const submissionInProgressRef = useRef(false);
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
  const [driveNotesError, setDriveNotesError] = useState('');
  const [isDriveProvisioning, setIsDriveProvisioning] = useState(false);
  const [driveProvisionMessage, setDriveProvisionMessage] = useState('');
  const [isDriveUploading, setIsDriveUploading] = useState(false);
  const [driveUploadMessage, setDriveUploadMessage] = useState('');
  const [isGoogleDriveConnected, setIsGoogleDriveConnected] = useState(false);
  const [drivePreviewFile, setDrivePreviewFile] = useState(null);
  const [isDrivePreviewFullscreen, setIsDrivePreviewFullscreen] = useState(false);
  const driveRequestSequenceRef = useRef(0);
  const driveUploadInputRef = useRef(null);
  const drivePreviewContainerRef = useRef(null);
  const notesDoubtLogRef = useRef(null);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsDrivePreviewFullscreen(document.fullscreenElement === drivePreviewContainerRef.current);
    };
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  useEffect(() => {
    const doubtLog = notesDoubtLogRef.current;
    if (doubtLog) doubtLog.scrollTop = doubtLog.scrollHeight;
  }, [notesDoubtMessages, isNotesDoubtLoading]);

  useEffect(() => {
    const syncDriveConnectionState = async () => {
      try {
        const status = await checkDriveConnection();
        setIsGoogleDriveConnected(Boolean(status.connected));
      } catch {
        setIsGoogleDriveConnected(false);
      }
    };
    void syncDriveConnectionState();
  }, []);

  useEffect(() => {
    const handleDriveQuery = () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('drive') === 'connected') {
        setIsGoogleDriveConnected(true);
        setDriveNotesError('');
        setDriveProvisionMessage('Google Drive connected successfully.');
        window.history.replaceState({}, '', window.location.pathname);
      }
      if (params.get('drive_error')) {
        const errors = {
          authorization_state_invalid: 'Google Drive authorization could not be verified. Start the connection again.',
          authorization_cancelled: 'Google Drive authorization was cancelled.',
          connection_failed: 'Google Drive connection failed. Check the OAuth configuration and try again.'
        };
        setDriveNotesError(errors[params.get('drive_error')] || 'Google Drive connection failed.');
        setIsGoogleDriveConnected(false);
        window.history.replaceState({}, '', window.location.pathname);
      }
    };
    handleDriveQuery();
  }, []);

  useEffect(() => {
    if (!selectedSubject && Object.keys(SUBJECT_TOPICS).length) {
      setSelectedSubject(Object.keys(SUBJECT_TOPICS)[0]);
    }
    if (selectedSubject && (!selectedTopic || !SUBJECT_TOPICS[selectedSubject]?.includes(selectedTopic))) {
      const nextTopic = SUBJECT_TOPICS[selectedSubject]?.[0] || '';
      setSelectedTopic(nextTopic);
    }
  }, [selectedSubject, selectedTopic]);

  const clearAccountSpecificState = () => {
    setSelectedExam('SI');
    setUserProgress({});
    setTestHistory([]);
    setSeenQuestionCount(0);
    setTestAttemptCounter(1);
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
    setDriveProvisionMessage('');
    setDriveUploadMessage('');
    setDrivePreviewFile(null);
    setPlannerData(createEmptyPlannerState());
    setPlannerSelectedDate(new Date().toISOString().split('T')[0]);
  };

  useEffect(() => {
    if (!currentMember || !isMemberHydrated) return;

    const members = readStoredMembers();
    const memberRecord = {
      ...currentMember,
      exam: selectedExam,
      userProgress,
      testHistory,
      seenQuestionCount,
      testAttemptCounter,
      plannerData
    };
    members[currentMember.id] = memberRecord;
    members[currentMember.email] = memberRecord;
    localStorage.setItem(MEMBERS_STORAGE_KEY, JSON.stringify(members));
  }, [currentMember, isMemberHydrated, selectedExam, userProgress, testHistory, seenQuestionCount, testAttemptCounter, plannerData]);

  useEffect(() => {
    if (!currentMember) return;
    const nextPlanner = buildPlannerSnapshot(currentMember, selectedExam, SUBJECT_TOPICS);
    setPlannerData((previous) => {
      const manualTasks = (previous?.schedule || []).filter((task) => !task.autoGenerated);
      const automaticTasks = (nextPlanner.schedule || []).filter((task) => task.autoGenerated);
      const combined = [...manualTasks, ...automaticTasks].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
      return {
        ...nextPlanner,
        schedule: combined,
        summary: {
          ...nextPlanner.summary,
          todaysTasks: combined.filter((task) => task.date === new Date().toISOString().split('T')[0]).length,
          upcomingTasks: combined.length
        }
      };
    });
  }, [currentMember, selectedExam, userProgress, testHistory]);

  const loadMember = (member) => {
    if (!member?.id) return;
    const plannerSnapshot = member.plannerData || createEmptyPlannerState(member);
    setCurrentMember(member);
    setPlannerData(plannerSnapshot);
    setSelectedExam(member.exam || 'SI');
    setUserProgress(member.userProgress || {});
    setTestHistory(member.testHistory || []);
    setSeenQuestionCount(member.seenQuestionCount || 0);
    setTestAttemptCounter(member.testAttemptCounter || 0);
    setActiveAttemptId(null);
    setCompletedAttempt(null);
    setActiveTestQuestions([]);
    setUserAnswers({});
    setCurrentQuestionIdx(0);
    setTimeRemaining(600);
    setCurrentView('dashboard');
    localStorage.setItem(ACTIVE_MEMBER_STORAGE_KEY, member.id);
    localStorage.setItem(LEGACY_ACTIVE_MEMBER_STORAGE_KEY, member.email);
  };

  const handleLogout = () => {
    localStorage.removeItem(ACTIVE_MEMBER_STORAGE_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_MEMBER_STORAGE_KEY);
    clearAccountSpecificState();
    setPlannerData(createEmptyPlannerState());
    setCurrentMember(null);
    setAuthPassword('');
    setAuthError('');
    setCurrentView('login');
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    if (isAuthenticating) return;

    const email = authEmail.trim().toLowerCase();
    const password = authPassword;
    setAuthError('');
    setIsAuthenticating(true);

    try {
      const members = readStoredMembers();
      if (currentView === 'signup') {
        const name = authName.trim();
        if (!name) throw new Error('Enter your name to create an account.');
        if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address.');
        if (password.length < 8) throw new Error('Use a password with at least 8 characters.');
        const existingMember = Object.values(members).find((member) => member?.email === email);
        if (existingMember) throw new Error('An account with this email already exists. Sign in instead.');

        const salt = createPasswordSalt();
        const member = {
          ...createEmptyMemberData(name, email),
          passwordSalt: salt.encoded,
          passwordHash: await hashPassword(password, salt.bytes)
        };
        members[member.id] = member;
        members[member.email] = member;
        localStorage.setItem(MEMBERS_STORAGE_KEY, JSON.stringify(members));
        loadMember(member);
      } else {
        const member = Object.values(members).find((candidate) => candidate?.email === email) || members[email];
        if (!member?.passwordSalt || !member?.passwordHash) {
          throw new Error('No account found for this email. Check the address or create an account.');
        }
        const passwordHash = await hashPassword(password, decodePasswordSalt(member.passwordSalt));
        if (passwordHash !== member.passwordHash) throw new Error('The email or password is incorrect.');
        loadMember(member);
      }
      setAuthPassword('');
    } catch (error) {
      setAuthError(error.message || 'Authentication could not be completed.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  // Launch a fresh AI-generated test.
  const handleStartTest = async (topic, difficulty) => {
    if (!selectedSubject || !selectedExam || !topic || !difficulty) {
      setQuestionGenerationError('Please select a valid subject, topic, and difficulty before generating questions.');
      return;
    }

    setSelectedTopic(topic);
    setActiveTestDifficulty(difficulty);
    setIsGeneratingQuestions(true);
    setQuestionGenerationError('');
    setQuestionGenerationNotice('Generating fresh questions with Gemini AI...');
    setCompletedAttempt(null);
    submissionInProgressRef.current = false;
    setIsSubmittingTest(false);

    const newSeed = testAttemptCounter + 1;
    setTestAttemptCounter(newSeed);

    try {
      const fresh10Questions = await generateQuestions({
        exam: normalizeExamForRequest(selectedExam),
        subject: selectedSubject,
        topic,
        difficulty,
        count: 10,
        attemptSeed: newSeed
      });
      setQuestionGenerationNotice('Fresh AI-generated questions loaded.');

      setSeenQuestionCount(prev => prev + 10);
      setActiveTestQuestions(fresh10Questions);
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
        difficulty: userProgress[selectedTopic]?.level || activeTestDifficulty || 'Beginner',
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
    if (!isGoogleDriveConnected) {
      setDriveNotesError('Connect your Google account to open the Notes Library.');
      return;
    }
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
    setDriveProvisionMessage('');
    setDriveUploadMessage('');
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

  const handleConnectGoogleDrive = async () => {
    try {
      const authUrl = await getDriveAuthUrl();
      window.location.href = authUrl;
    } catch (error) {
      setDriveNotesError(error.message || 'Google Drive connection could not be started.');
    }
  };

  const handleDisconnectGoogleDrive = async () => {
    try {
      await disconnectDrive();
      setIsGoogleDriveConnected(false);
      setDriveRootFolderId('');
      setDriveCurrentFolderId('');
      setDriveCurrentFolders([]);
      setDriveCurrentFiles([]);
      setDriveBreadcrumbs([]);
      setDriveCurrentSubject('');
      setDriveCurrentTopic('');
      setDriveNotesError('Google Drive disconnected.');
    } catch (error) {
      setDriveNotesError(error.message || 'Google Drive disconnect failed.');
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

  const handleProvisionDriveFolders = async () => {
    if (!driveRootFolderId || isDriveProvisioning) return;
    setIsDriveProvisioning(true);
    setDriveProvisionMessage('');
    setDriveNotesError('');
    try {
      const subjects = Object.entries(SUBJECT_TOPICS).map(([name, topics]) => ({ name, topics }));
      const result = await provisionDriveFolders(subjects);
      setDriveProvisionMessage(`Folder setup complete. Created ${result.createdSubjects} subjects and ${result.createdTopics} topics; existing folders were kept.`);
      await loadDriveFolder(driveRootFolderId, [{ id: driveRootFolderId, name: 'Subjects' }]);
    } catch (error) {
      setDriveNotesError(error.message || 'Google Drive folder setup failed.');
    } finally {
      setIsDriveProvisioning(false);
    }
  };

  const handleDriveFileSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setDriveNotesError('Files must be 20 MB or smaller.');
      return;
    }
    if (!/\.(pdf|doc|docx|txt|png|jpe?g|webp)$/i.test(file.name)) {
      setDriveNotesError('Upload PDF, DOC/DOCX, TXT, PNG, JPG/JPEG, or WebP files only.');
      return;
    }
    if (driveBreadcrumbs.length !== 3 || !driveCurrentFolderId || !driveBreadcrumbs[1]?.id) {
      setDriveNotesError('Choose a subject and topic folder before uploading.');
      return;
    }

    setIsDriveUploading(true);
    setDriveUploadMessage('');
    setDriveNotesError('');
    try {
      const uploadedFile = await uploadDriveFile(driveCurrentFolderId, driveBreadcrumbs[1].id, file);
      setDriveUploadMessage(`${uploadedFile.name} uploaded.`);
      await loadDriveFolder(driveCurrentFolderId, driveBreadcrumbs);
    } catch (error) {
      setDriveNotesError(error.message || 'Google Drive upload failed.');
    } finally {
      setIsDriveUploading(false);
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

  const handleFinalSubmitTest = () => {
    if (submissionInProgressRef.current) return;
    submissionInProgressRef.current = true;
    setIsSubmittingTest(true);
    setIsSubmitModalOpen(false);
    let didSubmit = false;

    try {
      if (activeTestQuestions.length !== 10) {
        setQuestionGenerationError('This test does not contain exactly 10 questions and cannot be scored. Please generate a new test.');
        setCurrentView('topic-detail');
        return;
      }

      const activeQuestionIds = new Set(activeTestQuestions.map((question) => question.id).filter(Boolean));
      const validAnswers = Object.fromEntries(
        Object.entries(userAnswers).filter(([questionId, answer]) => activeQuestionIds.has(questionId) && typeof answer === 'string')
      );
      const result = calculateTestResult(activeTestQuestions, validAnswers);
      const timeTakenSec = Math.max(0, 600 - (timeRemaining <= 1 ? 0 : timeRemaining));
      const mins = Math.floor(timeTakenSec / 60);
      const secs = timeTakenSec % 60;
      const formattedTime = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      const isPassed = result.total === 10 && result.correct >= 8;
      const nextLevelMap = { Beginner: 'Intermediate', Intermediate: 'Expert', Expert: 'Pro', Pro: 'Pro' };
      const attemptRecord = {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        exam: selectedExam,
        subject: selectedSubject,
        topic: selectedTopic,
        difficulty: activeTestDifficulty,
        score: result.correct,
        total: result.total,
        correct: result.correct,
        incorrect: result.incorrect,
        unanswered: result.unanswered,
        percentage: result.percentage,
        accuracy: result.accuracy,
        status: isPassed ? 'LEVEL PASSED' : 'PRACTICE REQUIRED',
        date: new Date().toISOString().split('T')[0],
        timeTaken: formattedTime,
        questions: result.details,
        answerKey: result.details.map((detail) => ({ questionId: detail.questionId, correctAnswer: detail.correctAnswer }))
      };

      setTestHistory((previousHistory) => [attemptRecord, ...previousHistory]);
      setCompletedAttempt(attemptRecord);
      setActiveAttemptId(attemptRecord.id);
      setUserProgress((previousProgress) => {
        const currentStats = previousProgress[selectedTopic] || { level: 'Beginner', bestScore: 0, attempts: 0, accuracy: 0 };
        const previousAttempts = currentStats.attempts || 0;
        return {
          ...previousProgress,
          [selectedTopic]: {
            level: isPassed ? nextLevelMap[activeTestDifficulty] : currentStats.level,
            bestScore: Math.max(currentStats.bestScore || 0, result.correct),
            attempts: previousAttempts + 1,
            accuracy: Math.round(((currentStats.accuracy || 0) * previousAttempts + result.accuracy) / (previousAttempts + 1))
          }
        };
      });
      setCurrentView('result');
      didSubmit = true;
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
      submitTestOnTimeout();
      return undefined;
    }
    const timer = setTimeout(() => setTimeRemaining(timeRemaining - 1), 1000);
    return () => clearTimeout(timer);
  }, [currentView, timeRemaining]);

  const handleExplainWithAI = (q) => {
    const userAns = q.userAnswer || userAnswers[q.id] || 'Not answered';
    setAiModalContent('Asking the AI tutor to explain this evaluated answer...');
    void sendChatMessage({
      exam: normalizeExamForRequest(activeAttemptData?.exam || selectedExam),
      subject: activeAttemptData?.subject || selectedSubject,
      topic: activeAttemptData?.topic || selectedTopic,
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
        exam: normalizeExamForRequest(selectedExam), subject: selectedSubject, topic: selectedTopic, difficulty: activeTestDifficulty || 'Beginner', messages: [
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
    setSelectedExam(attempt.exam || 'SI');
    setSelectedSubject(attempt.subject);
    setSelectedTopic(attempt.topic);
    setActiveTestDifficulty(attempt.difficulty || 'Beginner');
    setCurrentView('result');
  };

  const updatePlannerTask = (taskId, updates) => {
    setPlannerData((previous) => ({
      ...previous,
      schedule: (previous?.schedule || []).map((task) => task.id === taskId ? { ...task, ...updates, updatedAt: new Date().toISOString() } : task)
    }));
  };

  const deletePlannerTask = (taskId) => {
    setPlannerData((previous) => ({
      ...previous,
      schedule: (previous?.schedule || []).filter((task) => task.id !== taskId)
    }));
  };

  const handleAddPlannerTask = (event) => {
    event.preventDefault();
    if (!currentMember) return;
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

  const activeAttemptData = completedAttempt || testHistory.find((item) => item.id === activeAttemptId) || testHistory[0] || null;
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
      const attempts = testHistory.filter(attempt => attempt.subject === subject);
      const accuracy = attempts.length
        ? Math.round(attempts.reduce((total, attempt) => total + (attempt.accuracy || 0), 0) / attempts.length)
        : 0;
      return { subject: label, accuracy };
    });
  }, [testHistory]);

  const subjectProgressSummary = useMemo(() => {
    return Object.keys(SUBJECT_TOPICS).map((subject) => {
      const attempts = testHistory.filter((attempt) => attempt.subject === subject);
      const accuracy = attempts.length
        ? Math.round(attempts.reduce((total, attempt) => total + (attempt.accuracy || 0), 0) / attempts.length)
        : 0;
      const averageTopicScore = SUBJECT_TOPICS[subject].length
        ? SUBJECT_TOPICS[subject].reduce((sum, topic) => sum + (userProgress[topic]?.bestScore || 0), 0) / SUBJECT_TOPICS[subject].length
        : 0;
      const completion = Math.min(100, Math.round((accuracy * 0.7) + ((averageTopicScore / 10) * 30)));
      const status = getProgressStatus(completion);
      return {
        subject,
        accuracy,
        completion,
        status,
        colorClass: getStatusColorClass(status)
      };
    });
  }, [testHistory, userProgress]);

  const currentTopicProgress = userProgress[selectedTopic] || { level: 'Beginner', bestScore: 0, attempts: 0 };
  const currentLearningLevel = selectedNotesLearningStage || currentTopicProgress.level || activeTestDifficulty || 'Beginner';
  const currentLearningStageIndex = LEARNING_LEVEL_INDEX[currentLearningLevel] ?? 0;
  const visibleStudyNoteSections = studyNotes
    ? NOTE_SECTION_PRESENTATION
      .map((section) => ({ ...section, items: Array.isArray(studyNotes[section.key]) ? studyNotes[section.key].filter(Boolean) : [] }))
      .filter((section) => section.items.length > 0)
    : [];

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
            <p className="relative text-xs text-slate-500">Your account and progress are saved in this browser.</p>
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
                <button type="button" onClick={() => { setCurrentView('login'); setAuthError(''); }} className={`rounded-md py-2 text-sm font-semibold transition ${!isSignup ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>Log in</button>
                <button type="button" onClick={() => { setCurrentView('signup'); setAuthError(''); }} className={`rounded-md py-2 text-sm font-semibold transition ${isSignup ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>Sign up</button>
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
                {authError && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">{authError}</p>}
                <button type="submit" disabled={isAuthenticating} className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-teal-500 disabled:opacity-60">
                  {isSignup ? <UserPlus className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                  {isAuthenticating ? 'Please wait...' : isSignup ? 'Create account' : 'Log in'}
                </button>
              </form>
              <p className="mt-5 text-center text-xs text-slate-500">Accounts are stored locally in this browser and do not sync across devices.</p>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen w-full min-w-0 max-w-full bg-slate-900 text-slate-100 flex flex-col font-sans">
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
            onClick={() => setSelectedExam('SI')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${selectedExam === 'SI' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
          >
            TS SI
          </button>
          <button
            onClick={() => setSelectedExam('CONSTABLE')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${selectedExam === 'CONSTABLE' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
          >
            TS Constable
          </button>
        </div>

        {/* Top Header Actions */}
        <div className="ml-auto flex shrink-0 items-center space-x-2">
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
            <div className="pt-2 border-t border-slate-700/60">
              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
                <span>Drive</span>
                <span className={`inline-flex rounded-full px-2 py-0.5 ${isGoogleDriveConnected ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}>
                  {isGoogleDriveConnected ? 'Connected' : 'Not connected'}
                </span>
              </div>
              <button
                onClick={isGoogleDriveConnected ? handleDisconnectGoogleDrive : handleConnectGoogleDrive}
                className="mt-2 w-full rounded-lg border border-teal-500/40 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-teal-200 hover:bg-slate-700"
              >
                {isGoogleDriveConnected ? 'Disconnect Google Drive' : 'Connect Google Drive'}
              </button>
            </div>
          </div>
        </nav>

        {/* Content View Router */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 bg-slate-900">
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
                    Targeting <span className="text-blue-400 font-bold">Telangana {selectedExam}</span>. Your marks, attempts, and topic progress are saved to this member profile.
                  </p>
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium">Tests Attempted</p>
                  <p className="text-2xl font-black text-white mt-1">{testHistory.length}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium">Unique Questions Attempted</p>
                  <p className="text-2xl font-black text-emerald-400 mt-1">{seenQuestionCount}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium">Attempt Seed Version</p>
                  <p className="text-2xl font-black text-blue-400 mt-1">v{testAttemptCounter}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium">Unlocked Topics</p>
                  <p className="text-2xl font-black text-amber-400 mt-1">
                    {Object.keys(userProgress).length} / {TOTAL_TOPICS}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_0.7fr] gap-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-300">Smart Preparation</p>
                      <h3 className="mt-2 text-xl font-bold text-white">Overall Progress {plannerData?.summary?.overallProgress ?? 0}%</h3>
                    </div>
                    <button onClick={() => setCurrentView('planner')} className="rounded-lg border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200 hover:bg-teal-500/20">View Full Planner</button>
                  </div>
                  <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-[11px] text-slate-400">Syllabus Completed</p>
                      <p className="mt-2 text-xl font-black text-white">{plannerData?.summary?.syllabusCompletion ?? 0}%</p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-[11px] text-slate-400">Tests Attempted</p>
                      <p className="mt-2 text-xl font-black text-white">{plannerData?.summary?.testsAttempted ?? testHistory.length}</p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-[11px] text-slate-400">Average Accuracy</p>
                      <p className="mt-2 text-xl font-black text-emerald-300">{plannerData?.summary?.averageAccuracy ?? 0}%</p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                      <p className="text-[11px] text-slate-400">Days Remaining</p>
                      <p className="mt-2 text-xl font-black text-blue-300">{plannerData?.summary?.daysRemaining ?? 0}</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-5">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-300">Today&apos;s Plan</p>
                  <div className="mt-4 space-y-3">
                    {(plannerData?.schedule || []).filter((task) => task.date === new Date().toISOString().split('T')[0]).slice(0, 3).map((task) => (
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
                        onClick={() => { setSelectedSubject(subj); setCurrentView('topics'); }}
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
                  { label: 'Overall Progress', value: `${plannerData?.summary?.overallProgress ?? 0}%` },
                  { label: 'Syllabus Completion', value: `${plannerData?.summary?.syllabusCompletion ?? 0}%` },
                  { label: 'Tests Attempted', value: plannerData?.summary?.testsAttempted ?? testHistory.length },
                  { label: 'Average Accuracy', value: `${plannerData?.summary?.averageAccuracy ?? 0}%` },
                  { label: 'Critical Topics', value: plannerData?.summary?.criticalTopics ?? 0 }
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
                    <table className="min-w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-700 text-slate-400">
                          <th className="pb-2 pr-3 font-semibold">Topic</th>
                          <th className="pb-2 pr-3 font-semibold">Weightage</th>
                          <th className="pb-2 pr-3 font-semibold">Accuracy</th>
                          <th className="pb-2 pr-3 font-semibold">Completion</th>
                          <th className="pb-2 pr-3 font-semibold">Priority</th>
                          <th className="pb-2 pr-3 font-semibold">Last Attempt</th>
                          <th className="pb-2 font-semibold">Recommended</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(plannerData?.topicMetrics || []).slice(0, 8).map((metric) => (
                          <tr key={`${metric.subject}-${metric.topic}`} className="border-b border-slate-800 text-slate-300">
                            <td className="py-3 pr-3"><div className="font-semibold text-white">{metric.topic}</div><div className="text-[10px] text-slate-400">{metric.subject}</div></td>
                            <td className="py-3 pr-3">{metric.weightage}</td>
                            <td className="py-3 pr-3"><span className={getProgressColorClass(metric.accuracy)}>{metric.accuracy}%</span></td>
                            <td className="py-3 pr-3">{metric.completion}%</td>
                            <td className="py-3 pr-3"><span className={`rounded-full border px-2 py-1 font-bold ${getPriorityColorClass(metric.priority)}`}>{metric.priority}</span></td>
                            <td className="py-3 pr-3">{metric.lastAttempted || 'Not attempted'}</td>
                            <td className="py-3">{metric.recommendedMinutes} min</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
                    <span className="text-xs text-slate-400">{(plannerData?.schedule || []).length} tasks</span>
                  </div>
                  <div className="mt-4 space-y-3">
                    {(plannerData?.schedule || []).slice(0, 8).map((task) => (
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
                      const dateTasks = (plannerData?.schedule || []).filter((task) => task.date === dateKey);
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
                      {((plannerData?.schedule || []).filter((task) => task.date === plannerSelectedDate).length ? (plannerData?.schedule || []).filter((task) => task.date === plannerSelectedDate) : []).map((task) => (
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
                      onClick={() => { setSelectedSubject(subj); setCurrentView('topics'); }}
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

              {currentView === 'topics' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {SUBJECT_TOPICS[selectedSubject]?.map((topic) => {
                    const progress = userProgress[topic] || { level: "Beginner", bestScore: 0, attempts: 0 };
                    const weightage = getTopicWeightage(selectedSubject, topic);
                    const progressValue = Math.min(100, Math.round(((progress.bestScore || 0) / 10) * 100));
                    const progressStatus = getProgressStatus(progressValue);
                    const progressClass = getStatusColorClass(progressStatus);

                    return (
                      <div
                        key={topic}
                        onClick={() => { setSelectedTopic(topic); setStudyNotes(null); setSelectedNotesLearningStage(''); setStudyNotesError(''); setShowStudyNotes(false); setNotesDoubtMessages([]); setNotesDoubtInput(''); setNotesDoubtError(''); setCurrentView('topic-detail'); }}
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
                      <div className="flex flex-wrap gap-2">
                        {[selectedSubject, selectedTopic, normalizeExamForRequest(selectedExam), currentLearningLevel, 'AI Generated'].filter(Boolean).map((badge) => (
                          <span key={badge} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${badge === currentLearningLevel ? 'border-teal-500/40 bg-teal-500/10 text-teal-200' : 'border-slate-700 bg-slate-800 text-slate-300'}`}>
                            {badge}
                          </span>
                        ))}
                      </div>
                    </div>
                  </header>

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
                        {isLoadingStudyNotes ? 'Generating AI notes...' : studyNotes ? 'Show AI notes' : 'Generate AI notes'}
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
                        const currentLvl = userProgress[selectedTopic]?.level || "Beginner";
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
                              {isGeneratingQuestions ? 'Generating with AI...' : isUnlocked ? 'Launch AI Test' : 'Locked'}
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
                      Every attempt asks Gemini AI for 10 new questions specifically for <strong>{selectedTopic} ({userProgress[selectedTopic]?.level || 'Beginner'})</strong>.
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
                    <span>{selectedExam}</span> • <span>{selectedSubject}</span> • <span className="text-blue-400 font-semibold">{activeTestDifficulty} Level</span>
                  </div>
                  <h3 className="text-lg font-bold text-white flex items-center space-x-2">
                    <span>{selectedTopic}</span>
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-md font-bold">
                      ✨ Attempt Seed #{testAttemptCounter}
                    </span>
                  </h3>
                </div>

                <div className="flex items-center space-x-2 bg-slate-900 px-4 py-2 rounded-xl border border-slate-700 text-amber-400 font-mono font-bold text-base shadow-inner">
                  <Clock className="w-4 h-4 animate-pulse" />
                  <span>
                    {Math.floor(timeRemaining / 60).toString().padStart(2, '0')}:
                    {(timeRemaining % 60).toString().padStart(2, '0')}
                  </span>
                </div>
              </div>
              {questionGenerationNotice && (
                <p className="text-xs text-teal-300 bg-teal-500/10 border border-teal-500/20 rounded-lg px-3 py-2">
                  {questionGenerationNotice}
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
                    <span className="text-xs text-blue-400 font-semibold">{activeAttemptData.topic} • {activeAttemptData.difficulty}</span>
                    <h2 className="text-2xl font-extrabold text-white">Test Results</h2>
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
                  <button
                    onClick={() => handleStartTest(selectedTopic, activeTestDifficulty)}
                    className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow transition flex items-center justify-center space-x-2"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Attempt Again (New AI Questions)</span>
                  </button>
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
                  {isGoogleDriveConnected ? (
                    <button onClick={handleDisconnectGoogleDrive} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800">
                      Disconnect Google Drive
                    </button>
                  ) : (
                    <button onClick={handleConnectGoogleDrive} className="rounded-lg bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-500">
                      Connect Google Drive
                    </button>
                  )}
                  <button onClick={handleDriveBack} disabled={isDriveNotesLoading} className="flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-50">
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                </div>
              </div>

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

              <div className="flex flex-wrap items-center gap-3">
                {driveBreadcrumbs.length === 1 && driveCurrentFolderId === driveRootFolderId && (
                  <button onClick={handleProvisionDriveFolders} disabled={isDriveProvisioning || isDriveNotesLoading} className="flex items-center gap-2 rounded-lg border border-teal-500/40 bg-teal-600/15 px-3 py-2 text-xs font-semibold text-teal-200 hover:bg-teal-600/25 disabled:opacity-50">
                    <FolderPlus className="h-4 w-4" />
                    {isDriveProvisioning ? 'Creating missing folders...' : 'Create missing syllabus folders'}
                  </button>
                )}
                {driveBreadcrumbs.length === 3 && (
                  <>
                    <input
                      ref={driveUploadInputRef}
                      type="file"
                      accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,.webp"
                      className="hidden"
                      onChange={handleDriveFileSelected}
                    />
                    <button onClick={() => driveUploadInputRef.current?.click()} disabled={isDriveUploading || isDriveNotesLoading} className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                      <Upload className="h-4 w-4" />
                      {isDriveUploading ? 'Uploading...' : 'Upload note or image'}
                    </button>
                    <span className="text-xs text-slate-500">PDF, DOC/DOCX, TXT, PNG, JPG, WebP · up to 20 MB</span>
                  </>
                )}
              </div>

              {driveProvisionMessage && <p role="status" className="text-xs text-teal-200">{driveProvisionMessage}</p>}
              {driveUploadMessage && <p role="status" className="text-xs text-teal-200">{driveUploadMessage}</p>}

              {isDriveNotesLoading && <p className="text-sm text-slate-300">Loading Google Drive notes...</p>}
              {driveNotesError && <p role="alert" className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">{driveNotesError}</p>}

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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {driveCurrentFiles.map((file) => {
                      return (
                        <button
                          key={file.id}
                          type="button"
                          onClick={() => handleOpenDriveFile(file)}
                          className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-700 bg-slate-800 p-4 text-left hover:border-teal-500 hover:bg-slate-800/80"
                        >
                          <FileText className="h-5 w-5 shrink-0 text-teal-300" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold text-slate-100">{file.name}</span>
                            <span className="mt-1 block truncate text-xs text-slate-400">{file.mimeType}</span>
                            {file.modifiedTime && <span className="mt-1 block text-xs text-slate-500">Modified {new Date(file.modifiedTime).toLocaleDateString()}</span>}
                          </span>
                          <span className="shrink-0 text-xs font-semibold text-teal-300">View</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {!isDriveNotesLoading && !driveNotesError && driveBreadcrumbs.length >= 3 && !driveCurrentFiles.length && !driveCurrentFolders.length && (
                <div className="rounded-lg border border-dashed border-slate-600 bg-slate-800 p-8 text-center">
                  <BookOpen className="mx-auto mb-3 h-8 w-8 text-slate-500" />
                  <p className="text-sm text-slate-300">No files available in this topic.</p>
                </div>
              )}

              {!isDriveNotesLoading && !driveNotesError && driveBreadcrumbs.length === 1 && !driveCurrentFolders.length && !driveCurrentFiles.length && (
                <p className="rounded-lg border border-dashed border-slate-600 bg-slate-800 p-8 text-center text-sm text-slate-300">No subject folders were found in the configured Google Drive root.</p>
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
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-xl flex items-center space-x-4">
                <div className="w-16 h-16 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-full flex items-center justify-center text-white font-black text-xl shadow-lg">
                  {currentMember.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">{currentMember.name}</h3>
                  <p className="text-xs text-slate-400">{currentMember.email} · Targeting: Telangana {selectedExam}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <p className="text-xs text-slate-400">Total Attempts</p>
                  <p className="text-2xl font-black text-white mt-1">{testHistory.length}</p>
                </div>
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <p className="text-xs text-slate-400">Best Marks</p>
                  <p className="text-2xl font-black text-emerald-400 mt-1">{testHistory.length ? Math.max(...testHistory.map(att => att.score)) : 0}/10</p>
                </div>
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <p className="text-xs text-slate-400">Average Accuracy</p>
                  <p className="text-2xl font-black text-blue-400 mt-1">{testHistory.length ? Math.round(testHistory.reduce((sum, att) => sum + att.accuracy, 0) / testHistory.length) : 0}%</p>
                </div>
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                  <p className="text-xs text-slate-400">Questions Practiced</p>
                  <p className="text-2xl font-black text-amber-400 mt-1">{seenQuestionCount}</p>
                </div>
              </div>

              <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-xl space-y-4">
                <h3 className="text-lg font-bold text-white">Attempt Log</h3>
                {!testHistory.length && <p className="text-sm text-slate-400">No tests completed yet. Start a topic test to build your member history.</p>}
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
                      {testHistory.map((att) => (
                        <tr key={att.id} className="hover:bg-slate-700/30 transition">
                          <td className="p-3 font-semibold text-slate-100">
                            <button onClick={() => handleViewAttempt(att)} className="text-left text-blue-300 hover:text-blue-200 underline underline-offset-2">
                              {att.topic}
                            </button>
                          </td>
                          <td className="p-3">{att.difficulty}</td>
                          <td className="p-3 font-bold text-blue-400">{att.score}/10</td>
                          <td className="p-3">{att.accuracy}%</td>
                          <td className="p-3">
                            <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${att.status === 'LEVEL PASSED' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                              }`}>
                              {att.status}
                            </span>
                          </td>
                          <td className="p-3 text-slate-400">{att.date}</td>
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