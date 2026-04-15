<template>
  <div class="wizard-root">
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
  nextTick(() => spotlight.setTarget(step.target));
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

onMounted(() => {
  window.addEventListener('keydown', handleEscape);
  document.addEventListener('mousedown', handlePageInteraction, true);
  document.addEventListener('focusin', handlePageInteraction, true);
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
  document.removeEventListener('mousedown', handlePageInteraction, true);
  document.removeEventListener('focusin', handlePageInteraction, true);
  spotlight.cleanup();
});
</script>

<style scoped>
.wizard-root {
  font-family: 'DM Sans', system-ui, sans-serif;
}
</style>
