// Dev fixtures — integration flips USE_FIXTURES off; file stays for future dev/testing.
//
// Shapes mirror the frozen Expense Intelligence backend contract exactly:
//   GET  /api/expenses/analytics   -> ANALYTICS_FIXTURE
//   POST /api/expenses/ai/query    -> AI_QUERY_FIXTURE
//   GET  /api/expenses/ai/insights -> INSIGHTS_FIXTURE
//
// The ANALYTICS_FIXTURE numbers are internally consistent so components can be
// cross-checked against each other during dev:
//   summary.count      178   = Σ byType.count  = Σ byMonth.count = Σ byDriver.count
//                            = Σ byState.count (171) + noStateCount (7)
//                            = Σ byVendor.visits (155) + unknownVendorCount (23)
//   summary.totalSpend 57827.90 = Σ byType.spend = Σ byMonth.spend = Σ byDriver.spend
//                            = Σ byState.spend (55985.50) + noStateSpend (1842.40)
//                            = Σ byVendor.spend (53510.25) + unknownVendorSpend (4317.65)
//   summary.totalGallons 10286.4 = byType Fuel gallons = Σ byMonth = Σ byState = Σ byDriver
//                            (Σ byVendor gallons = 10086.4 — the remaining 200.0 gal
//                             sit on unknown-vendor fuel rows, matching the
//                             "run the vendor backfill" data-quality story)
//   avgPerGallon 3.73  = Fuel spend 38406.72 / 10286.4 gal
//   avgExpense   324.88 = 57827.90 / 178

export const ANALYTICS_FIXTURE = {
  summary: {
    totalSpend: 57827.9,
    count: 178,
    totalGallons: 10286.4,
    avgPerGallon: 3.73,
    avgExpense: 324.88,
    vendorsCount: 8,
    statesCount: 10,
    unknownVendorCount: 23,
    unknownVendorSpend: 4317.65,
    noStateCount: 7,
    noStateSpend: 1842.4,
    dateRange: { from: '2026-01-01', to: '2026-06-30' },
  },

  // ≤50 entries, spend desc.
  byVendor: [
    { vendor: 'PILOT FLYING J', visits: 44, spend: 15684.3, gallons: 3786.2, avgPerGallon: 3.71, states: ['CA', 'OR', 'NV', 'AZ', 'UT'], lastDate: '2026-06-27' },
    { vendor: "LOVE'S TRAVEL STOP", visits: 33, spend: 10930.85, gallons: 2748.6, avgPerGallon: 3.76, states: ['CA', 'TX', 'NM', 'AZ'], lastDate: '2026-06-24' },
    { vendor: 'TA PETRO', visits: 20, spend: 7284.1, gallons: 1772.4, avgPerGallon: 3.79, states: ['WA', 'OR', 'ID'], lastDate: '2026-06-18' },
    { vendor: 'FLEET SERVICES OF FRESNO', visits: 6, spend: 6238.4, gallons: 0, avgPerGallon: 0, states: ['CA'], lastDate: '2026-05-30' },
    { vendor: 'MAVERIK', visits: 22, spend: 3912.65, gallons: 1001.3, avgPerGallon: 3.65, states: ['UT', 'ID', 'NV'], lastDate: '2026-06-21' },
    { vendor: 'LES SCHWAB TIRE CENTER', visits: 4, spend: 3410.45, gallons: 0, avgPerGallon: 0, states: ['OR', 'WA'], lastDate: '2026-04-22' },
    { vendor: 'CHEVRON', visits: 12, spend: 3184.75, gallons: 777.9, avgPerGallon: 3.82, states: ['CA', 'OR'], lastDate: '2026-06-10' },
    { vendor: 'NAPA AUTO PARTS', visits: 14, spend: 2864.75, gallons: 0, avgPerGallon: 0, states: ['CA', 'OR', 'CO'], lastDate: '2026-06-05' },
  ],

  byState: [
    { state: 'CA', count: 38, spend: 14286.3, gallons: 2412.6 },
    { state: 'OR', count: 24, spend: 7412.85, gallons: 1384.2 },
    { state: 'WA', count: 21, spend: 6930.4, gallons: 1265.8 },
    { state: 'NV', count: 16, spend: 4872.15, gallons: 918.4 },
    { state: 'TX', count: 14, spend: 4721.35, gallons: 884.3 },
    { state: 'AZ', count: 15, spend: 4610.75, gallons: 872.1 },
    { state: 'UT', count: 13, spend: 3988.2, gallons: 726.5 },
    { state: 'CO', count: 11, spend: 3632.5, gallons: 785.0 },
    { state: 'ID', count: 10, spend: 2846.9, gallons: 534.9 },
    { state: 'NM', count: 9, spend: 2684.1, gallons: 502.6 },
  ],

  // Ascending by month.
  byMonth: [
    { month: '2026-01', count: 24, spend: 7412.3, gallons: 1402.6, avgPerGallon: 3.68 },
    { month: '2026-02', count: 27, spend: 8655.45, gallons: 1551.8, avgPerGallon: 3.71 },
    { month: '2026-03', count: 31, spend: 10286.75, gallons: 1830.4, avgPerGallon: 3.76 },
    { month: '2026-04', count: 30, spend: 9924.1, gallons: 1762.9, avgPerGallon: 3.7 },
    { month: '2026-05', count: 33, spend: 10893.55, gallons: 1914.2, avgPerGallon: 3.78 },
    { month: '2026-06', count: 33, spend: 10655.75, gallons: 1824.5, avgPerGallon: 3.75 },
  ],

  // All 7 canonical types.
  byType: [
    { type: 'Fuel', count: 96, spend: 38406.72, gallons: 10286.4 },
    { type: 'Repair', count: 11, spend: 8940.25, gallons: 0 },
    { type: 'Maintenance', count: 9, spend: 4612.8, gallons: 0 },
    { type: 'Wear & Tear', count: 6, spend: 2310.45, gallons: 0 },
    { type: 'Toll', count: 22, spend: 1486.9, gallons: 0 },
    { type: 'Food', count: 27, spend: 1178.63, gallons: 0 },
    { type: 'Other', count: 7, spend: 892.15, gallons: 0 },
  ],

  byDriver: [
    { driver: 'Marcus Johnson', count: 52, spend: 17204.35, gallons: 3102.6 },
    { driver: 'Derek Alvarez', count: 47, spend: 15318.2, gallons: 2748.9 },
    { driver: 'Sam Whitfield', count: 44, spend: 14092.75, gallons: 2486.5 },
    { driver: 'Tony Brooks', count: 35, spend: 11212.6, gallons: 1948.4 },
  ],

  // ≤500 entries; real US coordinates. vendor '' = unknown-vendor row.
  locations: [
    { id: 501, lat: 38.5816, lng: -121.4944, type: 'Fuel', amount: 412.35, vendor: 'PILOT FLYING J', city: 'Sacramento', state: 'CA', date: '2026-06-27', driver: 'Marcus Johnson' },
    { id: 502, lat: 35.3733, lng: -119.0187, type: 'Fuel', amount: 386.2, vendor: "LOVE'S TRAVEL STOP", city: 'Bakersfield', state: 'CA', date: '2026-06-24', driver: 'Derek Alvarez' },
    { id: 503, lat: 36.7378, lng: -119.7871, type: 'Repair', amount: 1240.8, vendor: 'FLEET SERVICES OF FRESNO', city: 'Fresno', state: 'CA', date: '2026-05-30', driver: 'Sam Whitfield' },
    { id: 504, lat: 45.5152, lng: -122.6784, type: 'Fuel', amount: 401.15, vendor: 'TA PETRO', city: 'Portland', state: 'OR', date: '2026-06-18', driver: 'Marcus Johnson' },
    { id: 505, lat: 42.3265, lng: -122.8756, type: 'Maintenance', amount: 865.4, vendor: 'LES SCHWAB TIRE CENTER', city: 'Medford', state: 'OR', date: '2026-04-22', driver: 'Tony Brooks' },
    { id: 506, lat: 47.6062, lng: -122.3321, type: 'Fuel', amount: 378.9, vendor: 'TA PETRO', city: 'Seattle', state: 'WA', date: '2026-06-12', driver: 'Derek Alvarez' },
    { id: 507, lat: 47.6588, lng: -117.426, type: 'Food', amount: 28.45, vendor: '', city: 'Spokane', state: 'WA', date: '2026-06-08', driver: 'Sam Whitfield' },
    { id: 508, lat: 39.5296, lng: -119.8138, type: 'Fuel', amount: 355.6, vendor: 'PILOT FLYING J', city: 'Reno', state: 'NV', date: '2026-06-15', driver: 'Tony Brooks' },
    { id: 509, lat: 36.1699, lng: -115.1398, type: 'Fuel', amount: 368.75, vendor: "LOVE'S TRAVEL STOP", city: 'Las Vegas', state: 'NV', date: '2026-05-28', driver: 'Marcus Johnson' },
    { id: 510, lat: 33.4484, lng: -112.074, type: 'Fuel', amount: 392.1, vendor: "LOVE'S TRAVEL STOP", city: 'Phoenix', state: 'AZ', date: '2026-06-02', driver: 'Derek Alvarez' },
    { id: 511, lat: 40.7608, lng: -111.891, type: 'Fuel', amount: 198.35, vendor: 'MAVERIK', city: 'Salt Lake City', state: 'UT', date: '2026-06-21', driver: 'Sam Whitfield' },
    { id: 512, lat: 43.615, lng: -116.2023, type: 'Fuel', amount: 176.8, vendor: 'MAVERIK', city: 'Boise', state: 'ID', date: '2026-06-19', driver: 'Tony Brooks' },
    { id: 513, lat: 31.7619, lng: -106.485, type: 'Fuel', amount: 405.25, vendor: "LOVE'S TRAVEL STOP", city: 'El Paso', state: 'TX', date: '2026-06-05', driver: 'Marcus Johnson' },
    { id: 514, lat: 35.0844, lng: -106.6504, type: 'Food', amount: 34.2, vendor: '', city: 'Albuquerque', state: 'NM', date: '2026-05-16', driver: 'Derek Alvarez' },
    { id: 515, lat: 39.7392, lng: -104.9903, type: 'Wear & Tear', amount: 214.6, vendor: 'NAPA AUTO PARTS', city: 'Denver', state: 'CO', date: '2026-06-05', driver: 'Sam Whitfield' },
  ],
}

// POST /api/expenses/ai/query — 200 shape. Rows echo the byVendor fixture so
// the AI panel and the vendor leaderboard agree during dev.
export const AI_QUERY_FIXTURE = {
  answer:
    "Pilot Flying J is your most-frequented vendor — 44 visits and $15,684.30 in spend over the last 6 months, ahead of Love's Travel Stop (33 visits) and Maverik (22).",
  unsupported: false,
  spec: {},
  columns: [
    { key: 'vendor', label: 'Vendor' },
    { key: 'visits', label: 'Visits' },
    { key: 'spend', label: 'Spend ($)' },
  ],
  rows: [
    { vendor: 'PILOT FLYING J', visits: 44, spend: 15684.3 },
    { vendor: "LOVE'S TRAVEL STOP", visits: 33, spend: 10930.85 },
    { vendor: 'MAVERIK', visits: 22, spend: 3912.65 },
    { vendor: 'TA PETRO', visits: 20, spend: 7284.1 },
    { vendor: 'CHEVRON', visits: 12, spend: 3184.75 },
  ],
  chartHint: 'bar',
}

// GET /api/expenses/ai/insights — 200 shape. Severities mix info/good/warn.
export const INSIGHTS_FIXTURE = {
  insights: [
    {
      title: 'Fuel spend trending up',
      detail:
        'June fuel spend ran about 8% above the 6-month average. Diesel in CA averaged $4.02/gal vs $3.65 in UT/ID — routing fills through Maverik along I-84 could trim roughly $0.37/gal.',
      severity: 'warn',
    },
    {
      title: 'Pilot pricing beats your blended average',
      detail:
        'Your average at Pilot Flying J is $3.71/gal — under your blended $3.73/gal and well under Chevron at $3.82. Volume is already concentrated there (44 visits), so the network discount is working.',
      severity: 'good',
    },
    {
      title: '23 expenses are missing vendor data',
      detail:
        'About $4,318 in spend (13% of expenses) has no vendor attached — mostly tolls and cash receipts from January to March. Run the vendor backfill to sharpen the leaderboard.',
      severity: 'info',
    },
    {
      title: 'Repair spend concentrated in one shop',
      detail:
        'Fleet Services of Fresno accounts for $6,238 of the $8,940 repair total (70%) across 6 visits. Worth a second quote before the next major job.',
      severity: 'warn',
    },
  ],
  generatedAt: '2026-07-08T14:00:00.000Z',
  cached: false,
}
