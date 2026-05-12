// Manifest of every screenshot embedded in the User Manual PDF.
//
// Each entry is captured by scripts/docs/capture-screenshots.js after logging in
// as the named user against a local dev server. The seeded test users come from
// scripts/truncate-and-seed.js + scripts/seed-staging.js:
//
//   super_admin / Password123!     (Super Admin)
//   dispatch1   / investor123      (Dispatcher)
//   lesline     / investor123      (Driver — Lesline Johnson)
//   kevin       / investor123      (Investor — owns 2 trucks)
//
// Each item has:
//   filename — basename written to docs/manual/assets/screenshots/
//   role     — one of: super_admin | dispatcher | driver | investor | public
//   route    — path (omit origin)
//   wait     — optional CSS selector to wait for before capturing
//   viewport — optional { width, height }; defaults to desktop unless role=driver
//   prep     — optional async fn(page) for additional setup
//   delay    — optional ms to wait after navigation for animations to settle

module.exports = [
	// PUBLIC FLOWS (no auth)
	{
		filename: "login.png",
		role: "public",
		route: "/login",
		delay: 800,
	},
	{
		filename: "public-apply.png",
		role: "public",
		route: "/apply",
		delay: 1200,
	},
	{
		filename: "public-invest.png",
		role: "public",
		route: "/invest",
		delay: 1500,
	},
	{
		filename: "public-track-search.png",
		role: "public",
		route: "/track",
		delay: 800,
	},

	// DRIVER
	{
		filename: "driver-onboarding.png",
		role: "driver",
		route: "/driver",
		viewport: { width: 414, height: 896 },
		delay: 1500,
	},
	{
		filename: "driver-loads.png",
		role: "driver",
		route: "/driver",
		viewport: { width: 414, height: 896 },
		delay: 1500,
	},
	{
		filename: "driver-pod.png",
		role: "driver",
		route: "/driver",
		viewport: { width: 414, height: 896 },
		delay: 1500,
	},

	// DISPATCHER
	{
		filename: "dispatcher-dashboard.png",
		role: "dispatcher",
		route: "/dashboard",
		delay: 2000,
	},
	{
		filename: "dispatcher-tracking.png",
		role: "dispatcher",
		route: "/tracking",
		delay: 2500,
	},

	// SUPER ADMIN
	{
		filename: "admin-users.png",
		role: "super_admin",
		route: "/users",
		delay: 1500,
	},
	{
		filename: "admin-applications.png",
		role: "super_admin",
		route: "/applications",
		delay: 1500,
	},
	{
		filename: "admin-financials.png",
		role: "super_admin",
		route: "/admin/financials",
		delay: 2500,
	},
	{
		filename: "admin-data-manager.png",
		role: "super_admin",
		route: "/data",
		delay: 2000,
	},
	{
		filename: "admin-tools.png",
		role: "super_admin",
		route: "/admin/tools",
		delay: 1500,
	},
	{
		filename: "admin-trucks.png",
		role: "super_admin",
		route: "/trucks",
		delay: 1500,
	},
	{
		filename: "admin-invoices.png",
		role: "super_admin",
		route: "/invoices",
		delay: 1500,
	},

	// INVESTOR
	{
		filename: "investor-hero.png",
		role: "investor",
		route: "/investor",
		delay: 2500,
	},
	{
		filename: "investor-earnings.png",
		role: "investor",
		route: "/investor",
		delay: 2500,
	},
	{
		filename: "investor-trucks.png",
		role: "investor",
		route: "/trucks",
		delay: 1500,
	},
];
