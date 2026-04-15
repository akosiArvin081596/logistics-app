import { reactive, computed } from 'vue';
import kb from '../data/knowledge-base.json';
import { evalExpression } from './expressionEvaluator.js';

const STORAGE_KEY = 'logisx_wizard_state';
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FIRST_STEP_ID = 'WELCOME';

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.lastSavedAt) return null;
    const savedAt = new Date(parsed.lastSavedAt).getTime();
    if (Number.isNaN(savedAt) || Date.now() - savedAt > STATE_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistState(state) {
  try {
    const payload = {
      currentStepId: state.currentStepId,
      history: state.history,
      completed: state.completed,
      dismissed: state.dismissed,
      lastSavedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage full or blocked — silently fall back to in-memory
  }
}

export function createWizardEngine({ getFormSnapshot } = {}) {
  const state = reactive({
    open: false,
    currentStepId: FIRST_STEP_ID,
    history: [],
    completed: false,
    dismissed: false,
    faqOpen: false,
    faqSearch: '',
    hasPersistedProgress: false,
  });

  const persisted = loadPersistedState();
  if (persisted) {
    state.currentStepId = persisted.currentStepId || FIRST_STEP_ID;
    state.history = Array.isArray(persisted.history) ? persisted.history : [];
    state.completed = !!persisted.completed;
    state.dismissed = !!persisted.dismissed;
    state.hasPersistedProgress = state.history.length > 0 || state.currentStepId !== FIRST_STEP_ID;
  }

  const currentStep = computed(() => kb.steps[state.currentStepId] || null);
  const totalSteps = computed(() => Object.keys(kb.steps).length);
  const progressIndex = computed(() => state.history.length);
  const progressPercent = computed(() => {
    const total = totalSteps.value || 1;
    return Math.min(100, Math.round(((progressIndex.value + 1) / total) * 100));
  });
  const canGoBack = computed(() => state.history.length > 0);

  function snapshot() {
    try {
      return getFormSnapshot ? getFormSnapshot() : {};
    } catch {
      return {};
    }
  }

  function resolveNext(step) {
    if (!step) return null;
    const next = step.next;
    if (!next) return null;
    if (typeof next === 'string') return next;
    if (Array.isArray(next)) {
      const ctx = snapshot();
      for (const branch of next) {
        if (!branch.when) return branch.goto;
        if (evalExpression(branch.when, ctx)) return branch.goto;
      }
    }
    return null;
  }

  function goToStep(stepId) {
    if (!stepId || !kb.steps[stepId]) return;
    state.history.push(state.currentStepId);
    state.currentStepId = stepId;
    persistState(state);
  }

  function replaceStep(stepId) {
    if (!stepId || !kb.steps[stepId]) return;
    state.currentStepId = stepId;
    persistState(state);
  }

  function next() {
    const nextId = resolveNext(currentStep.value);
    if (nextId) goToStep(nextId);
  }

  function back() {
    if (!canGoBack.value) return;
    state.currentStepId = state.history.pop();
    persistState(state);
  }

  function skip() {
    next();
  }

  function open() {
    state.open = true;
    state.dismissed = false;
  }

  function close() {
    state.open = false;
    persistState(state);
  }

  function dismiss() {
    state.open = false;
    state.dismissed = true;
    persistState(state);
  }

  function reset() {
    state.currentStepId = FIRST_STEP_ID;
    state.history = [];
    state.completed = false;
    state.dismissed = false;
    state.hasPersistedProgress = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function markCompleted() {
    state.completed = true;
    persistState(state);
  }

  function jumpTo(stepId) {
    if (!stepId || !kb.steps[stepId]) return;
    replaceStep(stepId);
  }

  function toggleFaq() {
    state.faqOpen = !state.faqOpen;
  }

  function findFaq(key) {
    return kb.faqs?.[key] || null;
  }

  function searchFaqs(query) {
    if (!query) return Object.entries(kb.faqs || {}).map(([id, v]) => ({ id, ...v }));
    const q = query.toLowerCase();
    return Object.entries(kb.faqs || {})
      .filter(([, v]) => v.q.toLowerCase().includes(q) || v.a.toLowerCase().includes(q))
      .map(([id, v]) => ({ id, ...v }));
  }

  function getKnowledgeBase() {
    return kb;
  }

  return {
    state,
    currentStep,
    progressIndex,
    progressPercent,
    canGoBack,
    totalSteps,
    next,
    back,
    skip,
    open,
    close,
    dismiss,
    reset,
    markCompleted,
    jumpTo,
    toggleFaq,
    findFaq,
    searchFaqs,
    getKnowledgeBase,
  };
}
