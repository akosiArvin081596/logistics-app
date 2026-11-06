// The driver app's side of a release (lib/driver-releases.js): asks the server what this driver hasn't
// read, then "What's new", the first-time offer and the tour. The rules are lib/driverReleaseNotices.js;
// DriverView hands in what it knows about the screen as functions. It reads and marks, and has no way
// to sign anyone out.
// Explicit .js, so scripts/test-driver-release-notices-client.mjs can run this under plain Node.
import { computed, ref, watch } from 'vue'
import {
  APP_TOUR_ROW,
  APP_TOUR_STEP_IDS,
  RELEASE_URL,
  SEEN_URL,
  TOUR_DONE_URL,
  WORDS,
  noteMoment,
  notesForScreen,
  releaseFromAnswer,
  tourCardView,
  tourStepsFor,
} from '../lib/driverReleaseNotices.js'

export function useDriverRelease(o) {
  // Only a good answer turns this on, so with the kill switch off the app shows nothing new.
  const featureOn = ref(false)
  const answer = ref(null)
  // Kept in the view only: a failed save brings the note back at the next app open, not sooner.
  const notesAnswered = ref(false)
  const offerAnswered = ref(false)
  const tour = ref(null)

  const tourOpen = computed(() => !!tour.value)
  const tourView = computed(() => (tour.value ? tourCardView(tour.value.steps, tour.value.index) : null))
  const entries = computed(() => (answer.value && !notesAnswered.value ? notesForScreen(answer.value.notes, o.has()) : []))
  const offerDue = computed(() => !!answer.value && answer.value.tourOffered && !offerAnswered.value)
  const noteView = computed(() => {
    const mode = entries.value.length ? 'notes' : offerDue.value ? 'offer' : ''
    if (!mode) return null
    if (!noteMoment({ ...o.noteInputs(), role: o.role(), tourOpen: tourOpen.value })) return null
    const steps = tourStepsFor(entries.value.flatMap((e) => e.tour), o.has())
    return { mode, entries: entries.value, canShowMe: steps.length > 0 }
  })

  let reads = 0

  // One moment: the app opened, or the driver came back to it or moved back to the list. DriverView
  // calls this from those places only. A read that fails leaves everything as it was, nothing new.
  async function check() {
    if (o.role() !== 'Driver' || o.onboarding() !== false || tour.value) return
    const mine = ++reads
    const current = () => mine === reads && o.mounted()
    let raw
    try {
      raw = await o.api.get(RELEASE_URL)
    } catch (err) {
      if (current() && err && err.status === 404) {
        featureOn.value = false
        answer.value = null
      }
      return
    }
    if (!current()) return
    const next = releaseFromAnswer(raw)
    if (!next) return
    featureOn.value = true
    answer.value = next
  }

  // A mark that fails holds nothing up; at worst the note comes back next time.
  function mark(url, ids) {
    if (!ids.length) return
    Promise.resolve()
      .then(() => o.api.post(url, { ids }))
      .catch(() => {})
  }

  function startTour(stepIds, doneIds) {
    const steps = tourStepsFor(stepIds, o.has())
    if (!steps.length) return false
    tour.value = { steps, index: 0, doneIds, from: o.place() }
    o.showStep(steps[0])
    return true
  }

  function endTour() {
    if (!tour.value) return
    const { from } = tour.value
    tour.value = null
    o.restorePlace(from)
  }

  function noteGotIt() {
    const shown = entries.value.map((e) => e.id)
    notesAnswered.value = true
    mark(SEEN_URL, shown)
  }

  function noteShowMe() {
    const shown = entries.value
    notesAnswered.value = true
    mark(SEEN_URL, shown.map((e) => e.id))
    startTour(shown.flatMap((e) => e.tour), shown.map((e) => e.id))
  }

  function offerTake() {
    offerAnswered.value = true
    mark(SEEN_URL, [APP_TOUR_ROW])
    startTour(APP_TOUR_STEP_IDS, [APP_TOUR_ROW])
  }

  function offerSkip() {
    offerAnswered.value = true
    mark(SEEN_URL, [APP_TOUR_ROW])
  }

  // The Kit's button: any time, except with the truck moving.
  function startAppTour() {
    if (o.motionAllowed() !== true) {
      o.toast(WORDS.whenParked)
      return
    }
    // Taking it from the Kit answers a first-time driver's offer too.
    if (offerDue.value) offerSkip()
    startTour(APP_TOUR_STEP_IDS, [APP_TOUR_ROW])
  }

  function tourNext() {
    if (!tour.value) return
    if (tour.value.index >= tour.value.steps.length - 1) {
      tourFinish()
      return
    }
    tour.value = { ...tour.value, index: tour.value.index + 1 }
    o.showStep(tour.value.steps[tour.value.index])
  }

  // Only finishing writes, and only this.
  function tourFinish() {
    if (!tour.value) return
    const { doneIds } = tour.value
    endTour()
    mark(TOUR_DONE_URL, doneIds)
  }

  // A skip writes nothing and asks nothing again.
  const tourSkip = endTour

  // The truck starts moving: the tour closes by itself.
  watch(() => o.motionAllowed(), (allowed) => {
    if (allowed !== true) endTour()
  })

  return {
    featureOn, noteView, tourOpen, tourView, check,
    noteGotIt, noteShowMe, offerTake, offerSkip, startAppTour,
    tourNext, tourSkip, tourFinish, closeTour: endTour,
  }
}
