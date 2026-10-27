## What and why
<!-- One paragraph. Link the issue. This repo is public: describe a security fix by its behaviour (gate, status code, error code), never by how it could be abused. -->

## Risk tier
<!-- Tick one. When unsure, take the higher tier. -->
- [ ] LOW: copy, layout, small UI, docs, or a refactor with no behaviour change
- [ ] NORMAL: a behaviour change that doesn't touch money, permissions or security
- [ ] HIGH: money, permissions or privacy, security or auth, a data fix or production data, or anything that writes to Sheets, n8n or Drive or changes what gets written there (code that only reads them is NORMAL)

## Evidence
<!-- Fill in the line for the tier you ticked and delete the other two. -->
- LOW: no new test. Browser check (replica / dev stack) only if something visual changed:
- NORMAL: the runner case added or changed, and its result: `node scripts/test-…`
- HIGH:
  - A test that fails on the base and passes here: `SERVER_JS=<base copy> node scripts/test-…`
  - Feature flag (name; off in production until approved):
  - Review by another agent (result; a High stops the merge):
  - The merge waits for the owner's yes; a read-only staging check follows the deploy

Screenshots: none with real people's data.

## Before production
- [ ] Needs a production `.env` change or a data fix (dry run attached)
