## What and why
<!-- One paragraph. Link the issue. This repo is public: describe a security fix by its behaviour (gate, status code, error code), never by how it could be abused. -->

## Evidence
- Failing test before the fix: `node scripts/test-…` (shown failing on the base, e.g. `SERVER_JS=<base copy>`)
- Ran locally: `npm run check` · e2e `ONLY=…` · browser check (replica / dev stack)
- Screenshots: none with real people's data

## Risk
- [ ] Touches money, payouts or invoices
- [ ] Touches permissions or auth
- [ ] Behind a feature flag (name, default):
- [ ] Needs a production `.env` change or a data fix (dry run attached)
