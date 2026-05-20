<template>
  <div class="wizard-root" :style="rootStyle">
    <WizardResumeBanner
      :show="showResumeBanner"
      @resume="handleResume"
      @dismiss="dismissResume"
    />
    <WizardSpotlight
      :rect="engine.state.open && !minimized ? spotlight.targetRect.value : null"
      :variant="activeHighlight"
    />
    <WizardPanel
      :open="engine.state.open"
      :minimized="minimized"
      :is-mobile="isMobile"
      :step="engine.currentStep.value"
      :progress-index="engine.progressIndex.value"
      :progress-percent="engine.progressPercent.value"
      :can-go-back="engine.canGoBack.value"
      :faq-lookup="engine.findFaq"
      @close="engine.close()"
      @next="handleNext"
      @back="engine.back()"
      @skip="engine.skip()"
      @open-faq="openFaqItem"
      @restore="restorePanel"
    />
    <WizardFaqDrawer
      :open="faqDrawerOpen"
      :items="faqItems"
      :active-faq="activeFaq"
      @close="closeFaqDrawer"
      @select="openFaqItem"
      @clear="clearActiveFaq"
    />
    <WizardFab
      :has-progress="engine.state.hasPersistedProgress && !engine.state.completed"
      :hidden="engine.state.open"
      @toggle="toggleWizard"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import WizardPanel from './WizardPanel.vue';
import WizardFab from './WizardFab.vue';
import WizardSpotlight from './WizardSpotlight.vue';
import WizardResumeBanner from './WizardResumeBanner.vue';
import WizardFaqDrawer from './WizardFaqDrawer.vue';
import { createWizardEngine } from '../engine/WizardEngine.js';
import { useSpotlight } from '../engine/spotlight.js';

const props = defineProps({
  pageStep: { type: Number, default: 0 },
  form: { type: Object, required: true },
  vehicles: { type: Array, default: () => [] },
  banking: { type: Object, required: true },
  signatures: { type: Object, default: () => ({}) },
  completed: { type: Boolean, default: false },
});

const emit = defineEmits(['jump-to']);

const engine = createWizardEngine({
  getFormSnapshot: () => ({
    field: props.form,
    vehicles: props.vehicles,
    banking: props.banking,
    signatures: props.signatures,
    step: props.pageStep,
  }),
});

const spotlight = useSpotlight();
const showResumeBanner = ref(false);
const faqDrawerOpen = ref(false);
const activeFaq = ref(null);
const minimized = ref(false);
const isMobile = ref(false);
const keyboardOffset = ref(0);

const rootStyle = computed(() => ({
  '--wizard-kb-offset': keyboardOffset.value + 'px',
}));

const activeHighlight = computed(() => {
  const step = engine.currentStep.value;
  return step?.highlight || 'spotlight';
});

const faqItems = computed(() => engine.searchFaqs(''));

function openFaqItem(id) {
  const faq = engine.findFaq(id);
  if (!faq) return;
  activeFaq.value = { id, ...faq };
  faqDrawerOpen.value = true;
}

function clearActiveFaq() {
  activeFaq.value = null;
}

function closeFaqDrawer() {
  faqDrawerOpen.value = false;
  activeFaq.value = null;
}

function toggleWizard() {
  if (engine.state.open && !minimized.value) {
    engine.close();
  } else {
    engine.open();
    minimized.value = false;
    showResumeBanner.value = false;
    applyCurrentTarget();
  }
}

function restorePanel() {
  if (!minimized.value) return;
  minimized.value = false;
  nextTick(() => applyCurrentTarget());
}

function handlePageInteraction(e) {
  if (!engine.state.open || minimized.value) return;
  const inWizard = e.target?.closest?.('.wizard-root, .wizard-panel, .wizard-fab, .faq-drawer, .wizard-resume');
  if (!inWizard) {
    minimized.value = true;
    spotlight.cleanup();
  }
}

function handleNext() {
  engine.next();
}

function handleResume() {
  showResumeBanner.value = false;
  engine.open();
}

function dismissResume() {
  showResumeBanner.value = false;
}

function applyCurrentTarget() {
  const step = engine.currentStep.value;
  if (!step || !step.target) {
    spotlight.cleanup();
    return;
  }
  nextTick(() => spotlight.setTarget(step.target, { scroll: !isMobile.value }));
}

function updateKeyboardOffset() {
  const vv = window.visualViewport;
  if (!vv) {
    keyboardOffset.value = 0;
    return;
  }
  const delta = window.innerHeight - vv.height - vv.offsetTop;
  keyboardOffset.value = delta > 40 ? delta : 0;
}

let mobileMedia = null;
function handleMobileChange(e) {
  isMobile.value = e.matches;
}

function handleEscape(e) {
  if (e.key === 'Escape' && engine.state.open) {
    engine.close();
  }
}

watch(() => engine.state.open, (isOpen) => {
  if (isOpen) {
    minimized.value = false;
    applyCurrentTarget();
  } else {
    spotlight.cleanup();
  }
});

watch(() => engine.state.currentStepId, () => {
  if (engine.state.open) {
    minimized.value = false;
    applyCurrentTarget();
  }
});

watch(() => props.completed, (isDone) => {
  if (isDone && !engine.state.completed) {
    engine.markCompleted();
    engine.jumpTo('COMPLETION');
  }
});

watch(
  () => ({
    mobile: isMobile.value,
    open: engine.state.open,
    minimized: minimized.value,
  }),
  ({ mobile, open, minimized: mn }) => {
    if (typeof document === 'undefined') return;
    const active = mobile && (open || mn);
    const expanded = mobile && open && !mn;
    document.body.classList.toggle('wizard-mobile-pill-active', active && mn);
    document.body.classList.toggle('wizard-mobile-panel-active', expanded);
  },
  { immediate: true }
);

onMounted(() => {
  mobileMedia = window.matchMedia('(max-width: 768px)');
  isMobile.value = mobileMedia.matches;
  if (typeof mobileMedia.addEventListener === 'function') {
    mobileMedia.addEventListener('change', handleMobileChange);
  } else if (typeof mobileMedia.addListener === 'function') {
    mobileMedia.addListener(handleMobileChange);
  }

  window.addEventListener('keydown', handleEscape);
  document.addEventListener('pointerdown', handlePageInteraction, true);
  document.addEventListener('focusin', handlePageInteraction, true);

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateKeyboardOffset);
    window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
    updateKeyboardOffset();
  }

  const urlParams = new URLSearchParams(window.location.search);
  const forceGuide = urlParams.get('guide') === '1';

  if (forceGuide) {
    engine.reset();
    engine.open();
    applyCurrentTarget();
    return;
  }

  if (engine.state.hasPersistedProgress && !engine.state.completed && !engine.state.dismissed) {
    showResumeBanner.value = true;
    return;
  }

  if (!engine.state.hasPersistedProgress && !engine.state.dismissed) {
    setTimeout(() => {
      if (!engine.state.dismissed) {
        engine.open();
        applyCurrentTarget();
      }
    }, 1200);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape);
  document.removeEventListener('pointerdown', handlePageInteraction, true);
  document.removeEventListener('focusin', handlePageInteraction, true);
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', updateKeyboardOffset);
    window.visualViewport.removeEventListener('scroll', updateKeyboardOffset);
  }
  if (mobileMedia) {
    if (typeof mobileMedia.removeEventListener === 'function') {
      mobileMedia.removeEventListener('change', handleMobileChange);
    } else if (typeof mobileMedia.removeListener === 'function') {
      mobileMedia.removeListener(handleMobileChange);
    }
  }
  document.body.classList.remove('wizard-mobile-pill-active');
  document.body.classList.remove('wizard-mobile-panel-active');
  spotlight.cleanup();
});
</script>

<style scoped>
.wizard-root {
  font-family: 'DM Sans', system-ui, sans-serif;
}
</style>

<style>
@media (max-width: 768px) {
  body.wizard-mobile-pill-active .invest-content {
    padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px)) !important;
  }
  body.wizard-mobile-panel-active .invest-content {
    padding-bottom: calc(52vh + env(safe-area-inset-bottom, 0px)) !important;
  }
}
</style>
