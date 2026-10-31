"use strict";
// The alert for Chromium's first launch failure in a process, by the app's two
// admin alert channels: an email to `to` (server.js hands it ADMIN_NOTIFY_EMAIL;
// nothing is mailed when that is empty) and an in-app dispatch notification.
//
// It never sends on its own: the caller hands it its own send functions, and
// lib/pdf-browser.js calls the alert at most once per process, and only when
// CHROMIUM_LAUNCH_ALERT_SEND is exactly "true"; otherwise a launch failure is
// one log line and nothing else.
//
// The text names what failed by setting name, never an error text, path or
// setting value, so nothing from the server's environment leaves in it.

const NOTICE_TYPE = "pdf-renderer-launch-failed";
const TITLE = "PDF renderer failed to start";

function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// create({ sendEmail, to, emailHtml, notify, log }) -> async ({ cause }) => { emailed, notified }
//   sendEmail(to, subject, html): resolves true when the mail was handed over.
//   emailHtml({ heading, bodyHtml }): the app's email frame.
//   notify({ type, title, body, metadata }): records and pushes the in-app notice.
// Each channel is tried on its own; a failure is logged and never thrown.
function create({ sendEmail, to, emailHtml, notify, log = console } = {}) {
	return async function alertLaunchFailure({ cause = "" } = {}) {
		const why = String(cause || "the browser process did not start").slice(0, 300);
		const body = `Chromium could not start (${why}). Invoices, payout statements and onboarding documents can't be rendered until it does; each render tries again. To undo the Chromium settings, turn their flags off and restart the app.`;
		let emailed = false;
		let notified = false;
		const recipient = String(to || "").trim();
		if (recipient && typeof sendEmail === "function") {
			try {
				const html = typeof emailHtml === "function"
					? emailHtml({ heading: TITLE, bodyHtml: `<p>${escapeHtml(body)}</p>` })
					: `<p>${escapeHtml(body)}</p>`;
				emailed = (await sendEmail(recipient, `LogisX: ${TITLE}`, html)) === true;
			} catch (e) {
				log.error(`[pdf-browser] the launch-failure alert email failed: ${(e && e.message) || e}`);
			}
		}
		if (typeof notify === "function") {
			try {
				await notify({ type: NOTICE_TYPE, title: TITLE, body, metadata: { cause: why } });
				notified = true;
			} catch (e) {
				log.error(`[pdf-browser] the launch-failure notification failed: ${(e && e.message) || e}`);
			}
		}
		return { emailed, notified };
	};
}

module.exports = { create, NOTICE_TYPE, TITLE };
