// The driver app's side of a release (lib/driver-releases.js). The server says what this driver hasn't
// confirmed, and this shows it only as the view opens right after a sign-in, or not at all, so a page
// already open never changes by itself, a moving truck's included. The note stays until they tap
// "I acknowledge", on the note or at the end of its tour, and closes once that's saved, or with a line
// saying it wasn't. The tour starts only on their own tap. The rules are lib/driverReleaseNotices.js;
// DriverView hands in what it knows about the screen as functions. It reads and marks, and has no way to
// sign anyone out.
// Explicit .js, so scripts/test-driver-release-notices-client.mjs can run this under plain Node.
import { computed, ref } from 'vue'
import {
  ACK_URL,
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
  const saving = ref(false)
  // "Show me" on a truck read as moving: the note says when, inside itself, since the app's own short
  // message sits under the note's overlay.
  const whenParked = ref(false)
  // The one look is over, however it went. The contacts prompt waits for this, so it can't take the look.
  const lookDone = ref(false)

  const tourOpen = computed(() => !!tour.value)
  const tourView = computed(() => {
    const card = tour.value ? tourCardView(tour.value.steps, tour.value.index, tour.value.release) : null
    return card ? { ...card, saving: saving.value } : null
  })
  const entries = computed(() => (answer.value ? notesForScreen(answer.value.notes, o.has()) : []))
  const noteView = computed(() => {
    // "Show me": the tour runs over the note, which waits under it until they acknowledge.
    if (tour.value) return null
    const mode = entries.value.length ? 'notes' : answer.value?.tourOffered ? 'offer' : ''
    if (!mode) return null
    const steps = tourStepsFor(entries.value.flatMap((e) => e.tour), o.has())
    return { mode, entries: entries.value, canShowMe: steps.length > 0, saving: saving.value, whenParked: whenParked.value }
  })
  const onScreen = computed(() => !!noteView.value || tourOpen.value)

  // The sign-in is spent here whatever comes of it: a failed read or a no from noteMoment() shows nothing
  // and marks nothing, so what they missed comes at a later sign-in rather than later on this page. The
  // read starts at once; the look also waits for `partsRead`, the Performance read, since the note's
  // lines depend on it. Any good answer still tells the Kit the feature is on.
  async function look(partsRead) {
    if (o.role() !== 'Driver') return
    const signedIn = o.takeSignIn()
    let raw
    try {
      ;[raw] = await Promise.all([o.api.get(RELEASE_URL), Promise.resolve(partsRead).catch(() => {})])
    } catch {
      return
    }
    const next = releaseFromAnswer(raw)
    if (!next) return
    featureOn.value = true
    if (signedIn && noteMoment(o.noteInputs())) answer.value = next
  }

  // Once, as the view opens.
  async function check(partsRead) {
    try {
      await look(partsRead)
    } finally {
      lookDone.value = true
    }
  }

  // The tour offer's answer and a finished tour: a mark that fails holds nothing up.
  function mark(url, ids) {
    if (!ids.length) return
    Promise.resolve()
      .then(() => o.api.post(url, { ids }))
      .catch(() => {})
  }

  // Their own tap. On a truck the app last read as moving it says when and starts nothing, and a tour
  // under way stays up until they end it: nothing here changes the page by itself. From the note, the
  // note itself says it, and the tour is the release's: it ends in I acknowledge.
  function startTour(stepIds, doneIds, fromNote = false) {
    if (o.motionAllowed() !== true) {
      if (fromNote) whenParked.value = true
      else o.toast(WORDS.whenParked)
      return
    }
    const steps = tourStepsFor(stepIds, o.has())
    if (!steps.length) return
    whenParked.value = false
    tour.value = { steps, index: 0, doneIds, from: o.place(), release: fromNote }
    o.showStep(steps[0])
  }

  function endTour() {
    if (!tour.value) return
    const { from } = tour.value
    tour.value = null
    o.restorePlace(from)
  }

  // The only answer to a note: I acknowledge, on the note or at the end of its tour. It waits for the
  // save and can't be sent twice. Saved, the note closes and a first-time driver's offer can follow; not
  // saved, it closes with a line, the app marks nothing, and they go on to their loads. If the server got
  // the tap before the answer was lost, it still counts.
  async function confirm(ids) {
    saving.value = true
    let saved = false
    try {
      const reply = await o.api.post(ACK_URL, { ids })
      saved = !!reply && reply.success === true
    } catch {
      saved = false
    }
    saving.value = false
    if (saved) {
      answer.value = { ...answer.value, notes: [] }
      return
    }
    answer.value = null
    o.toast(WORDS.notSaved, 'error')
  }

  // The note's own I acknowledge: the one way on a truck read as moving, where Show me starts nothing.
  async function noteAcknowledge() {
    const shown = entries.value.map((e) => e.id)
    if (saving.value || !shown.length) return
    await confirm(shown)
  }

  // "Show me" marks nothing: the tour runs over the note, so one left mid-tour, by leaving the app,
  // comes back unanswered at a later sign-in.
  function noteShowMe() {
    if (saving.value) return
    const shown = entries.value
    startTour(shown.flatMap((e) => e.tour), shown.map((e) => e.id), true)
  }

  // The release tour's last step: I acknowledge answers the note it came from, for the entries it
  // showed, saved before the tour and the note close. The finished tour keeps its own mark as well.
  async function tourAcknowledge() {
    if (!tour.value || !tour.value.release || saving.value) return
    const { doneIds } = tour.value
    await confirm(doneIds)
    endTour()
    mark(TOUR_DONE_URL, doneIds)
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
    if (!tour.value || saving.value) return
    if (tour.value.index >= tour.value.steps.length - 1) {
      if (tour.value.release) tourAcknowledge()
      else tourFinish()
      return
    }
    tour.value = { ...tour.value, index: tour.value.index + 1 }
    o.showStep(tour.value.steps[tour.value.index])
  }

  // The app tour's end: only the tour's own mark is written.
  function tourFinish() {
    if (!tour.value) return
    const { doneIds } = tour.value
    endTour()
    mark(TOUR_DONE_URL, doneIds)
  }

  // A skip writes nothing and asks nothing again. The release tour has none: it ends in I acknowledge.
  function tourSkip() {
    if (tour.value && tour.value.release) return
    endTour()
  }

  return {
    featureOn, noteView, onScreen, lookDone, tourOpen, tourView, check,
    noteAcknowledge, noteShowMe, offerTake, offerSkip, startAppTour,
    tourNext, tourSkip, tourFinish, closeTour: endTour,
  }
}
