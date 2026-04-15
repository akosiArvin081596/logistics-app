import { ref } from 'vue';

const DEFAULT_PADDING = 8;

export function useSpotlight() {
  const targetRect = ref(null);
  const targetVisible = ref(false);
  let currentTarget = null;
  let resizeObserver = null;
  let scrollHandler = null;
  let rafHandle = null;

  function measure(el) {
    if (!el || !el.getBoundingClientRect) {
      targetRect.value = null;
      targetVisible.value = false;
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      targetRect.value = null;
      targetVisible.value = false;
      return;
    }
    targetRect.value = {
      x: rect.left - DEFAULT_PADDING,
      y: rect.top - DEFAULT_PADDING,
      width: rect.width + DEFAULT_PADDING * 2,
      height: rect.height + DEFAULT_PADDING * 2,
    };
    targetVisible.value = true;
  }

  function scheduleMeasure(el) {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = requestAnimationFrame(() => measure(el));
  }

  function expandCollapsedAncestors(el) {
    let node = el?.parentElement;
    while (node) {
      if (node.tagName === 'DETAILS' && !node.open) {
        node.open = true;
      }
      node = node.parentElement;
    }
  }

  function setTarget(selector) {
    cleanup();
    if (!selector) {
      targetRect.value = null;
      targetVisible.value = false;
      return;
    }
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {
      el = null;
    }
    if (!el) {
      targetRect.value = null;
      targetVisible.value = false;
      return;
    }
    expandCollapsedAncestors(el);
    currentTarget = el;
    measure(el);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    scrollHandler = () => scheduleMeasure(el);
    window.addEventListener('scroll', scrollHandler, { passive: true, capture: true });
    window.addEventListener('resize', scrollHandler, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleMeasure(el));
      resizeObserver.observe(el);
    }
  }

  function cleanup() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (scrollHandler) {
      window.removeEventListener('scroll', scrollHandler, { capture: true });
      window.removeEventListener('resize', scrollHandler);
      scrollHandler = null;
    }
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    currentTarget = null;
  }

  return {
    targetRect,
    targetVisible,
    setTarget,
    cleanup,
  };
}
