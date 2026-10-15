// How the screens show broker contact data the API withholds from a
// non-Super-Admin. Display only: the server is the one that redacts
// (lib/broker-contact.js) and the one that refuses a changed cell
// (409 CONTACT_CELL_READ_ONLY). Runner: scripts/test-broker-contact-client.mjs.

// The note the rate-con review shows in place of the Broker fields.
export const BROKER_KEPT_NOTE =
  "The broker's contact details are kept with the load. Only a Super Admin can see them."

// The hint under an editor cell that holds broker contact details.
export const CONTACT_CELL_HINT = 'Holds broker contact details. Only a Super Admin can change this.'

// The editor columns of a served row that the server redacted by value and
// listed in `_withheldCells` (GET /api/dashboard): shown as served and
// read-only, since a save that changes one is refused. In the editor's column
// order; none for a Super Admin, who is served every value.
export function contactReadOnlyCells(job, editableHeaders, isSuperAdmin) {
  if (isSuperAdmin || !job || !Array.isArray(job._withheldCells)) return []
  const listed = new Set(job._withheldCells.map(String))
  return (editableHeaders || []).filter(h => listed.has(String(h)))
}

// The rate-con review's sections for this user. A non-Super-Admin gets no
// Broker section: the extract serves those fields empty, and the server takes
// them from the rate con for the load it creates, whatever the form sends.
export function rateConSectionsFor(sections, isSuperAdmin) {
  if (isSuperAdmin) return sections
  return (sections || []).filter(s => s.title !== 'Broker')
}
