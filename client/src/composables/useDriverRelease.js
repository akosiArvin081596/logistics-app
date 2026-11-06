// The driver app's side of a release (lib/driver-releases.js). The server says what this driver hasn't
// read, and this shows it only as the view opens right after a sign-in, or not at all, so a page already
// open never changes by itself, a moving truck's included. The tour starts only on their own tap. The rules
// are lib/driverReleaseNotices.js; DriverView hands in what it knows about the screen as functions. It
// reads and marks, and has no way to sign anyone out.
// Explicit .js, so scripts/test-driver-release-notices-client.mjs can run this under plain Node.
import { computed, ref } from 'vue'
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
  const tour = ref(null)

  const tourOpen = computed(() => !!tour.value)
  const tourView = computed(() => (tour.value ? tourCardView(tour.value.steps, tour.value.index) : null))
  const entries = computed(() => (answer.value ? notesForScreen(answer.value.notes, o.has()) : []))
  const noteView = computed(() => {
    const mode = entries.value.length ? 'notes' : answer.value?.tourOffered ? 'offer' : ''
    if (!mode) return null
    const steps = tourStepsFor(entries.value.flatMap((e) => e.tour), o.has())
    return { mode, entries: entries.value, canShowMe: steps.length > 0 }
  })
  const onScreen = computed(() => !!noteView.value || tourOpen.value)

  // Once, as the view opens. The sign-in is spent here whatever comes of it: a failed read or a no from
  // noteMoment() shows nothing and marks nothing, so what they missed comes at their next sign-in rather
  // than later on this page. Any good answer still tells the Kit the feature is on.
  async function check() {
    if (o.role() !== 'Driver') return
    const signedIn = o.takeSignIn()
    let raw
    try {
      raw = await o.api.get(RELEASE_URL)
    } catch {
      return
    }
    const next = releaseFromAnswer(raw)
    if (!next) return
    featureOn.value = true
    if (signedIn && noteMoment(o.noteInputs())) answer.value = next
  }

  // A mark that fails holds nothing up; at worst the note comes back at their next sign-in.
  function mark(url, ids) {
    if (!ids.length) return
    Promise.resolve()
      .then(() => o.api.post(url, { ids }))
      .catch(() => {})
  }

  // Their own tap. On a truck the app last read as moving it says when and starts nothing, and a tour
  // under way stays up until they end it: nothing here changes the page by itself.
  function startTour(stepIds, doneIds) {
    if (o.motionAllowed() !== true) {
      o.toast(WORDS.whenParked)
      return
    }
    const steps = tourStepsFor(stepIds, o.has())
    if (!steps.length) return
    tour.value = { steps, index: 0, doneIds, from: o.place() }
    o.showStep(steps[0])
  }

  function endTour() {
    if (!tour.value) return
    const { from } = tour.value
    tour.value = null
    o.restorePlace(from)
  }

  // A first-time driver's offer can follow this in the same answer.
  function noteGotIt() {
    const shown = entries.value.map((e) => e.id)
    answer.value = { ...answer.value, notes: [] }
    mark(SEEN_URL, shown)
  }

  function noteShowMe() {
    const shown = entries.value
    answer.value = null
    mark(SEEN_URL, shown.map((e) => e.id))
    startTour(shown.flatMap((e) => e.tour), shown.map((e) => e.id))
  }

  function offerSkip() {
    answer.value = null
    mark(SEEN_URL, [APP_TOUR_ROW])
  }

  function offerTake() {
    offerSkip()
    startTour(APP_TOUR_STEP_IDS, [APP_TOUR_ROW])
  }

  // The Kit's button, any time.
  function startAppTour() {
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

  return {
    featureOn, noteView, onScreen, tourOpen, tourView, check,
    noteGotIt, noteShowMe, offerTake, offerSkip, startAppTour,
    tourNext, tourSkip, tourFinish, closeTour: endTour,
  }
}
