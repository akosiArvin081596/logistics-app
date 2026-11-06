// The driver app's side of a release (lib/driver-releases.js): asks the server what's due, signs the
// driver out only as the app opens and only at a safe moment, then "What's new", the first-time offer
// and the tour. The rules are lib/driverReleaseNotices.js; DriverView hands in what it knows about the
// screen as functions.
// Explicit .js, so scripts/test-driver-release-notices-client.mjs can run this under plain Node.
import { computed, ref, watch } from 'vue'
import {
  APP_TOUR_ROW,
  APP_TOUR_STEP_IDS,
  RELEASE_URL,
  SEEN_URL,
  TOUR_DONE_URL,
  WORDS,
  browserStorage,
  leaveLoginNote,
  noteMoment,
  notesForScreen,
  releaseFromAnswer,
  rememberSignOut,
  signOutMoment,
  signedOutFor,
  tourCardView,
  tourStepsFor,
} from '../lib/driverReleaseNotices.js'

export function useDriverRelease(o) {
  const local = o.localStorage === undefined ? browserStorage('local') : o.localStorage
  const session = o.sessionStorage === undefined ? browserStorage('session') : o.sessionStorage
  const now = o.now || (() => Date.now())

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
    if (!noteMoment({ ...o.noteInputs(), role: o.role(), signInDue: answer.value.signInDue, tourOpen: tourOpen.value })) return null
    const steps = tourStepsFor(entries.value.flatMap((e) => e.tour), o.has())
    return { mode, entries: entries.value, canShowMe: steps.length > 0 }
  })

  let reads = 0
  let signingOut = false

  // One moment: he opened the app, came back to it, or moved back to the list himself. DriverView
  // calls this from those places only. Each reads the answer, for the note. Only the app opening
  // (`appOpening`, lib/appOpening.js) can go on to sign him out, never an app already open. A read
  // that fails, of this answer, his loads or the truck, leaves everything as it was: no sign-out,
  // nothing new.
  async function check({ appOpening = false } = {}) {
    if (o.role() !== 'Driver' || o.onboarding() !== false || tour.value || signingOut) return
    const mine = ++reads
    const current = () => mine === reads && o.mounted() && !signingOut
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
    if (!next.signInDue || appOpening !== true) return
    const userId = o.userId()
    if (signedOutFor(local, userId, next.releaseId)) return
    // His loads and the truck as they are now: a list read an hour ago, before a phone slept, can
    // say he has no load while he is hauling one.
    try {
      await o.refreshFacts()
    } catch {
      return
    }
    if (!current()) return
    // No await from this check to the sign-out, so what it read is what's on screen.
    if (!signOutMoment({ ...o.signOutInputs(), role: o.role(), signInDue: true, tourOpen: tourOpen.value })) return
    if (!rememberSignOut(local, userId, next.releaseId)) return
    signingOut = true
    leaveLoginNote(session, now())
    o.signOut()
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
