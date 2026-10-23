// The toast a failed chat send shows in the dispatch inbox: the server's own
// reason when it refused the recipient or the sender (who may write to whom,
// decision 30: 422 MESSAGE_RECIPIENT / MESSAGE_SENDER, e.g. "Pick a driver or
// an investor to send the message to."), else the generic text. Pinned by
// scripts/test-message-send-failure.mjs.
const REFUSAL_CODES = new Set(['MESSAGE_RECIPIENT', 'MESSAGE_SENDER'])

export function messageSendFailureText(err) {
  const reason = err && REFUSAL_CODES.has(err.code) && typeof err.message === 'string' ? err.message.trim() : ''
  return reason || 'Failed to send'
}
