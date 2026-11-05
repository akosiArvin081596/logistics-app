// Is another tab of this app open? A sign-out the app starts by itself takes every other tab with it
// (stores/auth.js follows it), and this page can't see what's typed or on its way out in them. So
// every page of the app answers on one channel, and a sign-out holds while anything answers.
// Pinned by scripts/test-driver-release-notices-client.mjs.

export const TAB_ANSWER_WAIT_MS = 500
const CHANNEL_NAME = 'logisx.appTabs.v1'
const ASK = 'ask'
const ANSWER = 'here'

// One channel per page, for asking and answering alike: a channel never hears its own post, so a
// page can't answer itself.
export function openAppTabs(Channel = globalThis.BroadcastChannel, waitMs = TAB_ANSWER_WAIT_MS) {
  const waiting = new Set()
  let channel = null
  try {
    channel = new Channel(CHANNEL_NAME)
    channel.onmessage = (event) => {
      if (event.data === ANSWER) {
        for (const settle of [...waiting]) settle(true)
      } else if (event.data === ASK) {
        try {
          channel.postMessage(ANSWER)
        } catch {
          /* this page is going away: it has nothing to answer for */
        }
      }
    }
  } catch {
    channel = null
  }

  return {
    // true: another tab answered. false: none did in time. null: this browser can't tell, which the
    // sign-out takes as a no, as it does any input it hasn't got. Never rejects.
    ask() {
      if (!channel) return Promise.resolve(null)
      return new Promise((resolve) => {
        let timer = null
        const settle = (answer) => {
          clearTimeout(timer)
          waiting.delete(settle)
          resolve(answer)
        }
        waiting.add(settle)
        timer = setTimeout(() => settle(false), waitMs)
        try {
          channel.postMessage(ASK)
        } catch {
          settle(null)
        }
      })
    },
    close() {
      for (const settle of [...waiting]) settle(null)
      try {
        channel?.close()
      } catch {
        /* already closed */
      }
      channel = null
    },
  }
}

let thisPage = null
// This page's one channel. main.js opens it at start, so every page of the app answers from then on.
export function thisPageTabs() {
  if (!thisPage) thisPage = openAppTabs()
  return thisPage
}
