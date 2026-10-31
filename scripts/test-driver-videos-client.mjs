#!/usr/bin/env node
// The driver training videos in the driver app (DRIVER_TRAINING_VIDEOS_ENABLED): the
// pure lib client/src/lib/driverVideos.js, and how DriverTrainingVideos.vue,
// DriverView.vue and the driver store use it. The server decides the placement
// (scripts/test-driver-training-videos.js); the app only shows what it is sent.
//   §1 the RouteMate embed URL: the no-cookie origin, /embed/<id>, and exactly
//      rel=0, playsinline=1, cc_load_policy=1, cc_lang_pref=en, hl=en (no autoplay,
//      playlist, mute, loop or modestbranding); the watch URL exact
//   §2 the frame's title, allow, referrer policy and sandbox, exact
//   §3 normalizePlacement(): exactly "onboarding" or "kit", else null
//   §4 parseVttCues() on made-up WebVTT: BOM, CRLF, header text, NOTE and STYLE
//      blocks, cue ids and settings, multi-line cues, tags and entities, hours;
//      empty, not WebVTT, over 64 KB, not a string; bad times dropped; hostile
//      lines parsed in order
//   §5 the card's words: never a screening result
//   §6 DriverTrainingVideos.vue: no frame before the tap, the frame bound to the
//      lib's values, the facade a named button, the YouTube link always shown, no
//      autoplay and no YouTube image, the walkthrough only with its files
//   §7 driverVideoAssets.js: walkthrough null, or the three `?url` files
//   §8 DriverView.vue: the lock-screen card after "Documents Received!" and before
//      "Start Driving", on the server's placement; the Kit card after the time-off
//      card
//   §9 the store: trainingVideos null, then the payload's word through
//      normalizePlacement()
//
// No DOM, no server, no build.
//   node scripts/test-driver-videos-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'driverVideos.js')
const ASSETS = path.join(ROOT, 'client', 'src', 'lib', 'driverVideoAssets.js')
const CARD = path.join(ROOT, 'client', 'src', 'components', 'driver', 'DriverTrainingVideos.vue')
const VIEW = path.join(ROOT, 'client', 'src', 'views', 'DriverView.vue')
const STORE = path.join(ROOT, 'client', 'src', 'stores', 'driver.js')

let pass = 0
let fail = 0
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok    ${name}`); return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}
function done() {
  console.log(`\ntest-driver-videos-client: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')

if (!fs.existsSync(LIB) || !fs.existsSync(CARD) || !fs.existsSync(ASSETS)) {
  eq('client/src/lib/driverVideos.js exists', fs.existsSync(LIB), true)
  eq('client/src/lib/driverVideoAssets.js exists', fs.existsSync(ASSETS), true)
  eq('client/src/components/driver/DriverTrainingVideos.vue exists', fs.existsSync(CARD), true)
  eq('DriverView.vue names DriverTrainingVideos', read(VIEW).includes('DriverTrainingVideos'), true)
  eq('the driver store keeps trainingVideos', read(STORE).includes('trainingVideos'), true)
  done()
}
const v = await import(pathToFileURL(LIB).href)
const card = read(CARD)
const view = read(VIEW)
const store = read(STORE)
const assets = read(ASSETS)
// A .vue file's <script setup> and <template>, apart.
const scriptOf = (src) => (src.match(/<script setup>([\s\S]*?)<\/script>/) || [])[1] || ''
const templateOf = (src) => src.slice(0, Math.max(0, src.indexOf('<script')))
const count = (text, needle) => text.split(needle).length - 1

// ── §1 the embed URL ─────────────────────────────────────────────────────────
console.log('§1 the RouteMate embed and watch URLs')
const embed = new URL(v.routemateEmbedUrl())
eq('§1 the frame origin is YouTube\'s no-cookie host', v.YOUTUBE_FRAME_ORIGIN, 'https://www.youtube-nocookie.com')
eq('§1 the embed URL is on that origin, over https, with no credentials or fragment',
  [embed.origin, embed.protocol, embed.username, embed.password, embed.hash], [v.YOUTUBE_FRAME_ORIGIN, 'https:', '', '', ''])
eq('§1 the path is /embed/<the RouteMate video>', [v.ROUTEMATE_VIDEO_ID, embed.pathname], ['GV9ztmoomgw', '/embed/GV9ztmoomgw'])
const params = [...embed.searchParams.entries()]
eq('§1 the query is exactly the five parameters, each once',
  params.map(([k, val]) => `${k}=${val}`).sort(), ['cc_lang_pref=en', 'cc_load_policy=1', 'hl=en', 'playsinline=1', 'rel=0'])
eq('§1 no autoplay, playlist, mute, loop, modestbranding, start, JS API or origin parameter',
  ['autoplay', 'list', 'playlist', 'mute', 'loop', 'modestbranding', 'start', 'enablejsapi', 'origin'].filter((k) => embed.searchParams.has(k)), [])
eq('§1 the same URL every call', v.routemateEmbedUrl(), v.routemateEmbedUrl())
eq('§1 the watch URL, exact', v.ROUTEMATE_WATCH_URL, 'https://www.youtube.com/watch?v=GV9ztmoomgw')

// ── §2 the frame attributes ──────────────────────────────────────────────────
console.log('\n§2 the frame\'s attributes')
eq('§2 title, allow, referrer policy and sandbox, exact', [v.ROUTEMATE_FRAME_TITLE, v.ROUTEMATE_FRAME_ALLOW, v.ROUTEMATE_FRAME_REFERRER_POLICY, v.ROUTEMATE_FRAME_SANDBOX], [
  'RouteMate ELD: how to log in to your mobile app',
  'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen',
  'strict-origin-when-cross-origin',
  'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation',
])
eq('§2 the sandbox never lets the frame navigate the app\'s page or submit forms',
  v.ROUTEMATE_FRAME_SANDBOX.split(' ').filter((t) => /top-navigation|allow-forms|allow-modals|allow-downloads/.test(t)), [])
eq('§2 the frame may not use the camera, microphone, location or autoplay',
  v.ROUTEMATE_FRAME_ALLOW.split(';').map((s) => s.trim()).filter((f) => /camera|microphone|geolocation|autoplay|clipboard|usb|payment/.test(f)), [])

// ── §3 the placement word ────────────────────────────────────────────────────
console.log('\n§3 normalizePlacement()')
eq('§3 the two words', [v.normalizePlacement('onboarding'), v.normalizePlacement('kit')], ['onboarding', 'kit'])
eq('§3 anything else: null', ['Kit', 'KIT', ' kit', 'kit ', 'onboarding ', 'Onboarding', 'lock', '', '__proto__', 'constructor', null, undefined, 0, 1, true, {}, [], ['kit']]
  .map(v.normalizePlacement), Array(18).fill(null))

// ── §4 the captions ──────────────────────────────────────────────────────────
console.log('\n§4 parseVttCues()')
const SAMPLE = [
  '﻿WEBVTT - made-up captions for the test',
  'Kind: captions',
  '',
  'NOTE written for this runner only',
  'it spans two lines',
  '',
  'STYLE',
  '::cue { color: yellow }',
  '',
  'intro-1',
  '00:00:04.000 --> 00:00:07.400 line:12% align:center size:92%',
  'Sign in with the username and password',
  'dispatch gave you.',
  '',
  '00:00:07.400 --> 00:00:09.600',
  '<v Narrator>Tap <i>Accept</i> &amp; go.</v>',
  '',
  '01:02:03.004 --> 01:02:05.500',
  'An hour in: &lt;still&gt; plain text&nbsp;here.',
  '',
].join('\r\n')
eq('§4 a full made-up file: three cues in order, tags and entities resolved, lines joined', v.parseVttCues(SAMPLE), [
  { start: 4, end: 7.4, text: 'Sign in with the username and password dispatch gave you.' },
  { start: 7.4, end: 9.6, text: 'Tap Accept & go.' },
  { start: 3723.004, end: 3725.5, text: 'An hour in: <still> plain text here.' },
])
eq('§4 LF and lone CR line ends read the same', [v.parseVttCues(SAMPLE.split('\r\n').join('\n')), v.parseVttCues(SAMPLE.split('\r\n').join('\r'))].map((c) => c.length), [3, 3])
eq('§4 empty, header only, not WebVTT, a header word inside a word: no cues',
  ['', 'WEBVTT', 'WEBVTT\n\n', 'WEBVTTX\n\n00:00:01.000 --> 00:00:02.000\nx', 'webvtt\n\n00:00:01.000 --> 00:00:02.000\nx', '1\n00:00:01.000 --> 00:00:02.000\nx'].map((t) => v.parseVttCues(t)),
  [[], [], [], [], [], []])
eq('§4 not a string: no cues', [null, undefined, 42, {}, ['WEBVTT']].map((t) => v.parseVttCues(t)), [[], [], [], [], []])
const big = 'WEBVTT\n\n' + '00:00:01.000 --> 00:00:02.000\nx\n\n'.repeat(3000)
eq('§4 over 64 KB: refused whole (the cap is 64 KB)', [big.length > v.VTT_MAX_CHARS, v.parseVttCues(big), v.VTT_MAX_CHARS], [true, [], 65536])
eq('§4 a cue with no forward time, a bad time, or no text is dropped', v.parseVttCues([
  'WEBVTT', '',
  '00:00:05.000 --> 00:00:05.000', 'same start and end', '',
  '00:00:06.000 --> 00:00:05.000', 'backwards', '',
  '00:00:61.000 --> 00:01:02.000', 'sixty-one seconds', '',
  '0:00:01.00 --> 0:00:02.000', 'two-digit milliseconds', '',
  '00:00:07.000 --> 00:00:08.000', '<b></b>', '',
  '00:00:09.000 --> 00:00:10.000', 'kept', '',
].join('\n')), [{ start: 9, end: 10, text: 'kept' }])
eq('§4 a timing line with no blank line before it ends the cue above and starts its own (as a player reads it)',
  v.parseVttCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\none\n00:00:02.000 --> 00:00:03.000\ntwo\nmore\n'), [
    { start: 1, end: 2, text: 'one' }, { start: 2, end: 3, text: 'two more' }])
eq('§4 at most 8 text lines a cue', v.parseVttCues(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${'w\n'.repeat(12)}`)[0].text, Array(8).fill('w').join(' '))
const hostile = [
  'WEBVTT', '',
  `00:00:01.000 --> 00:00:02.000`, `${'<'.repeat(20000)}`, '',
  `00:00:02.000 --> 00:00:03.000`, `${'-->'.repeat(2000)}`, '',
  `${'9'.repeat(3000)} --> 00:00:04.000`, 'a long first time', '',
  `00:00:04.000 --> 00:00:05.000 ${' '.repeat(5000)}x`, 'after', '',
].join('\n')
eq('§4 hostile lines (an unclosed tag, repeated arrows, a long time, long settings) leave only the good cue',
  v.parseVttCues(hostile), [{ start: 4, end: 5, text: 'after' }])

// ── §5 the words ─────────────────────────────────────────────────────────────
console.log('\n§5 the card\'s words')
const words = [
  v.TRAINING_VIDEOS_HEADING, v.ELD_VIDEO_TITLE, v.ELD_VIDEO_SUB, v.ELD_PLAY_LABEL, v.ELD_PLAY_NAME, v.ELD_DATA_NOTE, v.ELD_LINK_TEXT,
  v.WALKTHROUGH_TITLE, v.WALKTHROUGH_SUB, v.WALKTHROUGH_LINK_TEXT,
  v.trainingVideosIntro('onboarding', 1), v.trainingVideosIntro('onboarding', 2), v.trainingVideosIntro('kit', 1), v.trainingVideosIntro('kit', 2),
]
eq('§5 the plan\'s words', [v.TRAINING_VIDEOS_HEADING, v.ELD_VIDEO_TITLE, v.ELD_VIDEO_SUB, v.ELD_PLAY_LABEL, v.ELD_PLAY_NAME, v.ELD_DATA_NOTE, v.ELD_LINK_TEXT], [
  'Training videos', 'Sign in to your ELD (RouteMate)', 'A RouteMate video on YouTube', 'Play the ELD video', 'Play the ELD video (loads YouTube)',
  'Plays from YouTube and uses mobile data.', 'Can\'t play it here? Open it on YouTube'])
eq('§5 the lock screen\'s intro counts the videos it shows; the Kit\'s is the same either way', [
  v.trainingVideosIntro('onboarding', 2), v.trainingVideosIntro('onboarding', 1), v.trainingVideosIntro('kit', 1), v.trainingVideosIntro('kit', 2)], [
  'While we finish your screening, watch these two short videos. They stay on your Kit tab after you start driving.',
  'While we finish your screening, watch this short video. It stays on your Kit tab after you start driving.',
  'Rewatch any time.', 'Rewatch any time.'])
eq('§5 no word says a result, pass, fail, drug or test', words.filter((t) => /\b(results?|pass(ed)?|fail(ed)?|drug|tests?|positive|negative)\b/i.test(t)), [])
eq('§5 the walkthrough\'s data note: the size when known, nothing otherwise',
  [v.walkthroughDataNote(8.4), v.walkthroughDataNote(null), v.walkthroughDataNote(0), v.walkthroughDataNote(NaN)], ['About 8 MB. Use Wi-Fi if you can.', '', '', ''])

// ── §6 the card ──────────────────────────────────────────────────────────────
console.log('\n§6 DriverTrainingVideos.vue')
const ct = templateOf(card)
const cs = scriptOf(card)
const frame = (ct.match(/<iframe[\s\S]*?><\/iframe>/) || [''])[0]
eq('§6 one iframe, created only by the tap (v-if="playing"), and the facade otherwise',
  [count(ct, '<iframe'), /<iframe\s+v-if="playing"/.test(ct), /<button v-else type="button" class="tv-facade" :aria-label="ELD_PLAY_NAME"[^>]*@click="play">/.test(ct)], [1, true, true])
eq('§6 playing starts false; the tap sets it and moves focus into the frame',
  [cs.includes('const playing = ref(false)'), /async function play\(\) \{\s*playing\.value = true\s*await nextTick\(\)\s*frameEl\.value\?\.focus\(\)\s*\}/.test(cs)], [true, true])
eq('§6 the frame binds the lib\'s title, sandbox, referrer policy, allow and URL, with allowfullscreen', [
  frame.includes(':title="ROUTEMATE_FRAME_TITLE"'), frame.includes(':sandbox="ROUTEMATE_FRAME_SANDBOX"'),
  frame.includes(':referrerpolicy="ROUTEMATE_FRAME_REFERRER_POLICY"'), frame.includes(':allow="ROUTEMATE_FRAME_ALLOW"'),
  /\sallowfullscreen\s/.test(frame), frame.includes(':src="embedUrl"'), cs.includes('const embedUrl = routemateEmbedUrl()'),
], [true, true, true, true, true, true, true])
eq('§6 the sandbox and referrer policy are set before the src (they apply to the first load)',
  [frame.indexOf(':sandbox=') < frame.indexOf(':src='), frame.indexOf(':referrerpolicy=') < frame.indexOf(':src=')], [true, true])
eq('§6 the YouTube link is always shown, opens apart and sends no referrer or opener',
  /<a class="tv-link" :href="ROUTEMATE_WATCH_URL" target="_blank" rel="noopener noreferrer" data-testid="tv-eld-link">\{\{ ELD_LINK_TEXT \}\}<\/a>/.test(ct)
    && !/v-if[^>]*tv-eld-link|tv-eld-link[^>]*v-if/.test(ct), true)
eq('§6 a real heading, a figure per video', [/<h2 :id="headingId" class="tv-heading">/.test(ct), count(ct, '<figure'), count(ct, '<figcaption')], [true, 2, 2])
eq('§6 no autoplay, no YouTube image, no other remote address in the card',
  [/autoplay/i.test(card), /ytimg|i\.youtube|<img/i.test(card), (card.match(/https?:\/\/[^\s'"`)]+/g) || [])], [false, false, []])
const videoTag = (ct.match(/<video\b[^>]*>/) || [''])[0]
eq('§6 the walkthrough only when its files exist; controls, nothing loaded before play, no inline play on an iPhone', [
  /<figure v-if="walkthrough"/.test(ct), /^<video class="tv-video" controls preload="none" :poster="walkthrough\.poster"/.test(videoTag), /playsinline|autoplay|muted|loop/.test(videoTag),
], [true, true, false])
eq('§6 captions on by default, English', /<track kind="captions" srclang="en" label="English" :src="walkthrough\.vtt" default>/.test(ct), true)
eq('§6 the steps are read only when "Read the steps" opens, once, from the captions file', [
  count(cs, 'fetch('), /async function onStepsToggle\(event\) \{\s*if \(!event\.target\.open \|\| steps\.state !== 'idle' \|\| !walkthrough\) return/.test(cs),
  cs.includes("fetch(walkthrough.vtt, { credentials: 'same-origin' })"), cs.includes('parseVttCues(await res.text())'), /<details class="tv-steps" @toggle="onStepsToggle">/.test(ct),
], [1, true, true, true, true])
eq('§6 the card keeps nothing in the browser\'s storage', /localStorage|sessionStorage|indexedDB|document\.cookie/.test(card), false)
eq('§6 the facade\'s tap target is the whole 16:9 frame (absolute, inset 0, full size)',
  [/\.tv-frame \{[^}]*aspect-ratio: 16 \/ 9;/.test(card), /\.tv-iframe,\s*\.tv-facade \{\s*position: absolute;\s*inset: 0;\s*width: 100%;\s*height: 100%;/.test(card)], [true, true])
eq('§6 the links\' tap targets are at least 44 px tall', /\.tv-link \{[^}]*min-height: 44px;/.test(card), true)

// ── §7 the assets file ───────────────────────────────────────────────────────
console.log('\n§7 driverVideoAssets.js')
const NAMES = ['logisx-driver-app-walkthrough.mp4', 'logisx-driver-app-walkthrough.en.vtt', 'logisx-driver-app-walkthrough-poster.jpg']
const assetsNull = /^export const walkthrough = null$/m.test(assets)
const assetsFilled = NAMES.every((n) => assets.includes(`'../assets/driver-videos/${n}?url'`)) && /export const walkthrough = Object\.freeze\(\{ mp4, vtt, poster \}\)/.test(assets)
eq('§7 walkthrough is null, or the three files as ?url imports (frozen)', assetsNull !== assetsFilled, true)
eq('§7 ...and nothing else is fetched or imported from elsewhere', /https?:\/\//.test(assets), false)

// ── §8 DriverView.vue ────────────────────────────────────────────────────────
console.log('\n§8 DriverView.vue')
const vt = templateOf(view)
const vs = scriptOf(view)
const lockCard = '<DriverTrainingVideos v-if="driverStore.trainingVideos === \'onboarding\'" variant="onboarding" />'
const kitCard = '<DriverTrainingVideos v-if="driverStore.trainingVideos === \'kit\'" variant="kit" />'
eq('§8 the card twice: once per placement, each on the server\'s word', [count(vt, '<DriverTrainingVideos'), count(vt, lockCard), count(vt, kitCard)], [2, 1, 1])
const at = (needle) => vt.indexOf(needle)
eq('§8 the lock-screen card sits after "Documents Received!" (and the contacts item) and before "Start Driving", inside the lock screen', [
  at('data-testid="ob-contacts"') < at(lockCard), at('Onboarding Status: Documents Received!') < at(lockCard), at(lockCard) < at('Start Driving'),
  at(lockCard) < at('<template v-else-if="initialLoadFailed">'),
], [true, true, true, true])
eq('§8 it is never keyed on the client\'s document count', /allDocsSigned|signedCount[^\n]*DriverTrainingVideos|DriverTrainingVideos[^\n]*signedCount/.test(view), false)
const kitStart = at('<!-- KIT TAB -->')
const kitEnd = vt.indexOf('</section>', kitStart)
eq('§8 the Kit card is inside the Kit tab, after the time-off card', [kitStart < at(kitCard), at(kitCard) < kitEnd, at('<DriverTimeOffCard\n            v-if="driverStore.timeOff"') < at(kitCard)], [true, true, true])
eq('§8 the component is imported once', count(vs, "import DriverTrainingVideos from '../components/driver/DriverTrainingVideos.vue'"), 1)

// ── §9 the store ─────────────────────────────────────────────────────────────
console.log('\n§9 the driver store')
eq('§9 trainingVideos starts null and holds only the payload\'s word, through normalizePlacement()', [
  /\n {4}trainingVideos: null,\n/.test(store), count(store, 'this.trainingVideos = normalizePlacement(data.trainingVideos)'), count(store, 'this.trainingVideos ='),
  store.includes("import { normalizePlacement } from '../lib/driverVideos'"),
], [true, 1, 1, true])

done()
