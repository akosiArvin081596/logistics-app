# Public Workflows

Three things in LogisX require no account: applying to drive, applying to invest, and tracking a load as a customer. This chapter walks through each.

## Applying as a driver

Anyone with a CDL can apply to drive for LogisX by going to `apply.logisx.com` (or `app.logisx.com/apply`). The application is a single multi-step form. Your progress is shown in a sidebar so you can see where you are.

![Driver application form](screenshots/public-apply.png)

The steps:

1. **Personal info.** Full name, email, phone, date of birth, address. The address field uses autocomplete — start typing and pick the matching result so the city, state, and ZIP fill in correctly. If you're applying from your phone and the form offers a **"Use my location"** button, you can tap it to skip typing your address.

2. **Driving history.** Years of CDL experience, types of equipment you've driven (dry van, reefer, flatbed, etc.), and any accidents or violations in the last few years. Be honest — discrepancies between what you report and what the FMCSA Clearinghouse shows will surface during onboarding.

3. **Certifications.** Your CDL class, endorsements (Hazmat, Tanker, etc.), and current medical card status.

4. **References.** Two or three professional references — usually a former supervisor at a prior carrier, ideally someone we can reach by phone.

5. **Prior employment.** A list of your previous carriers, with dates and reasons for leaving.

When you submit, the application is sent to the LogisX team for review. You'll receive an email confirming receipt. If accepted, a second email follows with your sign-in credentials and a link to start onboarding.

The whole submission takes about 10–20 minutes if you have your CDL, medical card, and prior carrier info handy.

## Applying as an investor

To apply for investment in the LogisX fleet, go to `app.logisx.com/invest`. The application is a multi-step **wizard** with a visual progress indicator, guided highlights, and conditional sections that appear based on your earlier answers.

![Investor application wizard](screenshots/public-invest.png)

The high-level steps:

1. **Personal or company information.** If you're investing as an individual, fill in your name and contact info. If as a company, fill in company name and your role.

2. **Investment details.** How much capital you intend to deploy and how many trucks you target. This is non-binding — it helps the team plan the conversation.

3. **Legal agreement.** Read the high-level terms of the LogisX Master Participation & Management Agreement (the same agreement you'll later sign as part of onboarding). Acknowledge that you've read it.

4. **Funding source.** Where the capital will come from — personal savings, business funds, financing, etc.

5. **References.** Optional, but helpful. A banker or accountant who can vouch for you accelerates the review.

Submit and the application lands with LogisX leadership. If you're accepted, you'll be invited to onboarding — a separate signing flow for the formal documents (Master Agreement, Vehicle Lease, W-9). After onboarding, your investor dashboard activates and you begin seeing earnings as your fleet runs loads.

## Tracking a load as a customer

If you're a broker or shipper with a load running with LogisX, you can track it without an account. Go to `app.logisx.com/track`. You'll see a simple search box.

![Public tracker — search](screenshots/public-track-search.png)

Enter the **Load ID** (e.g., `LD-1234`) and tap **Track**. If the load exists, you see a tracker page with:

- **Current status** — Dispatched, In Transit, At Receiver, Delivered, or similar.
- **Live location** on a map (updated as the truck reports GPS).
- **Estimated time of arrival** at destination, with an on-time/delayed indicator.
- **Pickup and delivery addresses** — city, state, ZIP.
- **Truck unit number** — useful for security at the delivery facility.

![Public tracker — result](screenshots/public-track-result.png)

The tracker does **not** show:

- Driver name or phone.
- Broker name or contact.
- Rate or any financial info.
- Internal notes.

This is intentional — the tracker is for the customer's reasonable awareness of their load, not for the rest of the operational detail.

If you get a "Load not found" message, double-check the Load ID for typos. If the ID is correct but the load isn't found, contact LogisX dispatch — the load may not be in the system yet, or it may have been completed and rolled out of the tracker.

### Sharing the tracking link

If you're forwarding the tracking link to a final customer or a yard, just send the URL — anyone with the link can access the tracker. Once the load is delivered, the page shows the final delivered status and remains accessible for reference.

There's no requirement to "check in" or refresh — the page updates automatically.

## Why these flows are public

Three different audiences, three different reasons:

- **Driver application** is public because we want to be findable when a driver is looking for a job. Requiring an account just to ask "are you hiring?" is a barrier.
- **Investor application** is public for the same reason — discovery is the bottleneck for new investor relationships.
- **Customer tracker** is public because the customer doesn't have, and shouldn't need, an account in our system. Trying to gate it would force us to issue credentials to every broker on every load — a maintenance nightmare for everyone.

Each public flow is rate-limited and (where relevant) scrubbed of sensitive data, so going through them carries the same security posture as any other public web form.
