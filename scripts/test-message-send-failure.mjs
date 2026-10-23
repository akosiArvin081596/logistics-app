#!/usr/bin/env node
// scripts/test-message-send-failure.mjs — the dispatch inbox's toast when a
// send fails (client/src/lib/messageSendFailure.js): the server's own reason
// for a refused recipient or sender (decision 30), the generic text otherwise,
// and MessagingPanel.vue showing it.
// Run: node scripts/test-message-send-failure.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { messageSendFailureText } from '../client/src/lib/messageSendFailure.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (name, cond) => {
  if (cond) console.log(`ok    ${name}`)
  else { failed++; console.log(`FAIL  ${name}`) }
}
const apiError = (message, code, status) => Object.assign(new Error(message), { code, status })

ok('a refused recipient shows the server\'s reason',
  messageSendFailureText(apiError('Pick a driver or an investor to send the message to.', 'MESSAGE_RECIPIENT', 422)) === 'Pick a driver or an investor to send the message to.')
ok('a refused sender shows the server\'s reason',
  messageSendFailureText(apiError('Send as Dispatch or as yourself.', 'MESSAGE_SENDER', 422)) === 'Send as Dispatch or as yourself.')
ok('any other failure keeps "Failed to send"',
  messageSendFailureText(apiError('Internal error', '', 500)) === 'Failed to send'
  && messageSendFailureText(apiError('That attachment can\'t be sent.', 'ATTACHMENT_TYPE_RESERVED', 400)) === 'Failed to send')
ok('a refusal with no message, or no error at all, keeps "Failed to send"',
  messageSendFailureText(apiError('  ', 'MESSAGE_RECIPIENT', 422)) === 'Failed to send'
  && messageSendFailureText(null) === 'Failed to send' && messageSendFailureText(undefined) === 'Failed to send')

const panel = fs.readFileSync(path.join(here, '..', 'client', 'src', 'components', 'dashboard', 'MessagingPanel.vue'), 'utf8')
ok('MessagingPanel.vue toasts messageSendFailureText(err) when a send fails',
  /import \{ messageSendFailureText \} from '\.\.\/\.\.\/lib\/messageSendFailure'/.test(panel)
  && /\} catch \(err\) \{[\s\S]{0,600}?toast\(messageSendFailureText\(err\), 'error'\)/.test(panel)
  && !/toast\('Failed to send', 'error'\)/.test(panel))

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
