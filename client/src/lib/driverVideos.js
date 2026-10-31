// The driver training videos (components/driver/DriverTrainingVideos.vue): the
// RouteMate ELD video on YouTube's no-cookie host, the placement word the server
// puts on the driver payload, the card's words, and the walkthrough's captions.
// Pure, so scripts/test-driver-videos-client.mjs and scripts/test-csp-frame-src.js
// import it under plain Node; the video files' URLs are in driverVideoAssets.js.

// The one origin the site's frame-src gains for this (scripts/test-csp-frame-src.js
// reads it from here, so the two can't drift).
export const YOUTUBE_FRAME_ORIGIN = 'https://www.youtube-nocookie.com'
export const ROUTEMATE_VIDEO_ID = 'GV9ztmoomgw'
export const ROUTEMATE_WATCH_URL = `https://www.youtube.com/watch?v=${ROUTEMATE_VIDEO_ID}`

// Captions on where the video has them, end-screen suggestions from the same
// channel only, inline on an iPhone. No autoplay, playlist, loop or mute.
const EMBED_PARAMS = Object.freeze([
  ['rel', '0'],
  ['playsinline', '1'],
  ['cc_load_policy', '1'],
  ['cc_lang_pref', 'en'],
  ['hl', 'en'],
])

export function routemateEmbedUrl() {
  return `${YOUTUBE_FRAME_ORIGIN}/embed/${ROUTEMATE_VIDEO_ID}?${new URLSearchParams(EMBED_PARAMS).toString()}`
}

// The player frame. The sandbox keeps it from navigating the app's page; YouTube
// needs a referrer origin to play, which the element's own policy sends whatever
// the page-wide header says.
export const ROUTEMATE_FRAME_TITLE = 'RouteMate ELD: how to log in to your mobile app'
export const ROUTEMATE_FRAME_ALLOW = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen'
export const ROUTEMATE_FRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin'
export const ROUTEMATE_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation'

// The payload's `trainingVideos`: exactly "onboarding" or "kit", else nothing.
export function normalizePlacement(value) {
  return value === 'onboarding' || value === 'kit' ? value : null
}

// The walkthrough file's size, for the data note; null until the file exists.
export const WALKTHROUGH_APPROX_MB = null

// The card's words. Never a screening result: the driver is not told one.
export const TRAINING_VIDEOS_HEADING = 'Training videos'
export const ELD_VIDEO_TITLE = 'Sign in to your ELD (RouteMate)'
export const ELD_VIDEO_SUB = 'A RouteMate video on YouTube'
export const ELD_PLAY_LABEL = 'Play the ELD video'
export const ELD_PLAY_NAME = 'Play the ELD video (loads YouTube)'
export const ELD_DATA_NOTE = 'Plays from YouTube and uses mobile data.'
export const ELD_LINK_TEXT = "Can't play it here? Open it on YouTube"
export const WALKTHROUGH_TITLE = 'How to use the LogisX driver app'
export const WALKTHROUGH_SUB = 'About 4 minutes · captions on'
export const WALKTHROUGH_LINK_TEXT = "Can't play it? Open the video file"

export function trainingVideosIntro(variant, count) {
  if (variant === 'kit') return 'Rewatch any time.'
  return count > 1
    ? 'While we finish your screening, watch these two short videos. They stay on your Kit tab after you start driving.'
    : 'While we finish your screening, watch this short video. It stays on your Kit tab after you start driving.'
}

export function walkthroughDataNote(mb) {
  return Number.isFinite(mb) && mb > 0 ? `About ${Math.round(mb)} MB. Use Wi-Fi if you can.` : ''
}

// ── WebVTT cues, for the walkthrough's "Read the steps" ──────────────────────
// The file is ours and about 5 KB; anything over the cap is refused whole. Every
// pattern below runs on a short, length-checked token or is a fixed string.
export const VTT_MAX_CHARS = 64 * 1024
const MAX_CUES = 2000
const MAX_CUE_LINES = 8
const MAX_LINE_CHARS = 500
const MAX_TIMESTAMP_CHARS = 16
const TIMESTAMP_RE = /^(?:(\d{1,3}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/

// Whole milliseconds first, so 01:02:03.004 is 3723.004 and not a float sum.
function vttSeconds(token) {
  if (typeof token !== 'string' || token.length > MAX_TIMESTAMP_CHARS) return null
  const m = TIMESTAMP_RE.exec(token)
  if (!m) return null
  return (Number(m[1] || 0) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4])) / 1000
}

// A cue line's text without its tags (<v Narrator>, <i>, <00:00:01.000>); an
// unclosed tag drops the rest of the line, as a player would.
function withoutTags(line) {
  let out = ''
  let i = 0
  while (i < line.length) {
    const open = line.indexOf('<', i)
    if (open < 0) { out += line.slice(i); break }
    out += line.slice(i, open)
    const close = line.indexOf('>', open + 1)
    if (close < 0) break
    i = close + 1
  }
  return out
}

function decodeEntities(text) {
  return text
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&nbsp;').join(' ')
    .split('&lrm;').join('')
    .split('&rlm;').join('')
    .split('&amp;').join('&')
}

const isBlank = (line) => line.trim() === ''

// One cue from its timing line and text lines, or null when either is unusable.
function cueOf(timing, textLines) {
  const arrow = timing.indexOf('-->')
  const start = vttSeconds(timing.slice(0, arrow).trim())
  const end = vttSeconds(timing.slice(arrow + 3).trim().split(/\s/)[0])
  if (start === null || end === null || !(end > start)) return null
  const text = textLines
    .map((l) => decodeEntities(withoutTags(l.slice(0, MAX_LINE_CHARS))))
    .join(' ')
    .split(/\s/)
    .filter(Boolean)
    .join(' ')
  return text ? { start, end, text } : null
}

// [{ start, end, text }] in seconds, in file order; [] for anything that is not
// a WebVTT file within the cap. Cues with no text or no forward time are dropped.
// As in a player, a line holding "-->" ends the cue before it and starts the next.
export function parseVttCues(input) {
  if (typeof input !== 'string' || input.length > VTT_MAX_CHARS) return []
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const lines = text.split(/\r\n|\r|\n/)
  const first = lines[0] || ''
  if (!(first === 'WEBVTT' || first.startsWith('WEBVTT ') || first.startsWith('WEBVTT\t'))) return []
  const cues = []
  let i = 1
  while (i < lines.length && !isBlank(lines[i])) i++
  while (i < lines.length && cues.length < MAX_CUES) {
    if (isBlank(lines[i])) { i++; continue }
    const block = []
    while (i < lines.length && !isBlank(lines[i])) { block.push(lines[i]); i++ }
    let j = 0
    while (j < block.length && cues.length < MAX_CUES) {
      const at = block[j].includes('-->') ? j : j + 1 < block.length && block[j + 1].includes('-->') ? j + 1 : -1
      if (at < 0) break
      let k = at + 1
      while (k < block.length && !block[k].includes('-->')) k++
      const cue = cueOf(block[at], block.slice(at + 1, Math.min(k, at + 1 + MAX_CUE_LINES)))
      if (cue) cues.push(cue)
      j = k
    }
  }
  return cues
}
