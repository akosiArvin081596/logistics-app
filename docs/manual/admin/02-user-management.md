# User Management

The Users screen is where you manage every account that can sign in to LogisX. This chapter covers creating, editing, and removing users, plus the role system.

## Opening Users

Sidebar → **Users**. You'll see every user account in a table with:

- Username.
- Role.
- Full name.
- Email.
- Linked driver or company (for Drivers and Investors).
- Status (active or disabled, if your install supports).
- Creation date.

![Users page](screenshots/admin-users.png)

## The four roles

LogisX has four roles. Each has a different access scope:

| Role | What they see and do |
|---|---|
| **Super Admin** | Everything. The role you have. |
| **Dispatcher** | Operations dashboard, assignments, tracking, expenses (view), messages. No financials, no user mgmt, no cancellations. |
| **Driver** | The driver app at `/driver`. Their own loads, status, POD, expenses, messages, truck documents, invoices. |
| **Investor** | The investor dashboard at `/investor`. Earnings for trucks they own, fleet view, reports, documents, messaging. |

A user has exactly one role. Roles change via the Users page; the user gets logged out (forced re-sign-in) when their role changes.

## Creating a user

Click **Add User** at the top of the Users page. The form:

- **Username** — what they sign in with. Make it consistent (we use patterns like `LogisX-XXXX` for drivers, last names for dispatchers).
- **Password** — initial temporary password. They change it on first sign-in.
- **Role** — pick from the four.
- **Full name** — for display in the app.
- **Email** — for notifications and password resets.
- **Phone** (optional) — for calling outside the app.
- **Linked driver** (for Drivers) — pick the matching record from the drivers directory.
- **Linked carrier / company** (for Investors) — pick the carrier name. This is what links them to the trucks and loads in their fleet.

Save. The user can now sign in.

**For Drivers:** the linked driver name must match what appears on Job Tracking loads (case-insensitive). Without this match, the driver will see no loads. If you're not sure of the exact spelling, look at the Carrier Database (Drivers page) before creating the account.

**For Investors:** the linked company name must match the `company_name` field used on Job Tracking's Owner ID column (or carrier-name fallback). Same matching rule.

## Editing a user

Click any user row to open their detail. Edit any field, save.

Common edits:

- **Reset password** — set a new temporary password and share with the user. Use the dedicated **Reset Password** button rather than typing into the form; the password gets hashed correctly.
- **Change role** — only Super Admin can do this. Promoting or demoting takes effect immediately and forces re-sign-in.
- **Update email** — if they switched personal email.
- **Update linked driver / company** — if they changed assignments.

## Deleting a user

Click **Delete** on the user's row (or in their detail view). Confirm.

The user can no longer sign in. Their historical activity remains:

- Their authored messages, status updates, expense submissions, etc. are preserved.
- Their name might still appear on old loads.
- Their submitted applications (if a Driver who was hired) stay.

Deletion is reversible by recreating the user with the same username, but it's not seamless — the new user starts with no session history. Be deliberate.

## Roles and permissions in detail

Each role has a specific set of permissions. The exact list is documented in the Technical Documentation; the day-to-day implications:

**Super Admin:** Read + write everywhere. Approval authority on expenses, invoices, applications. Cancellation authority on loads. Direct database access.

**Dispatcher:** Read + write on operational records (loads, assignments, status, messages). Read-only on financials, applications, archives. No user management, no approval rights.

**Driver:** Read + write on their own loads only. No visibility into other drivers' work. No financial dashboard. No admin tools.

**Investor:** Read-only on their fleet's performance data. Read-only on their signed documents. Read + write on messages with operations. No operational controls.

## Changing a user's role

Be deliberate. The implications:

- **Driver → Dispatcher.** They go from seeing only their loads to seeing the whole operation. Usually only done for former drivers transitioning into office roles.
- **Dispatcher → Super Admin.** Big jump. They gain financial visibility and approval rights. Usually only for promotions.
- **Super Admin → Dispatcher.** They lose financial visibility. Usually only for role rotations.
- **Investor → anything else.** Rare. Investors don't usually transition to operational roles.

A role change triggers immediate logout. The user has to sign in again, and their new session reflects the new permissions.

## Linking accounts to data

The user record has two link fields:

**`driver_name`** for Driver users. This is the name LogisX uses to match the user account to their dispatch identity on Job Tracking loads. The match is case-insensitive. Examples:

- User account `LogisX-4778` with `driver_name = "Lesline Johnson"` → sees all loads assigned to "Lesline Johnson" (or "LESLINE JOHNSON" or any case variant).

**`company_name`** for Investor users. Links to the Carrier Database carrier names. Examples:

- Investor user `johnny.rocks.spirits.llc` with `company_name = "Johnny Rocks Spirits LLC"` → sees revenue and trucks where the carrier matches that name.

Mismatches between these link fields and the actual data cause dashboard issues (drivers see no loads; investors see no earnings). When troubleshooting, check the link first.

## When a user account isn't linking correctly

Common scenarios:

**Driver signs in and sees no loads.** Check:

1. Their `driver_name` field on the user record.
2. The driver names actually on Job Tracking (Data Manager → Job Tracking → look at the Driver column).
3. Are they spelled the same? Case-insensitive match, but typos matter ("Jonhson" vs. "Johnson" — actually happened historically; we fixed it).

**Investor signs in and sees $0 earnings.** Check:

1. Their `company_name` on the user record.
2. The carrier names on the Carrier Database.
3. The `Owner ID` column on Job Tracking — does it point to their investor record ID?
4. Run the "Scan driver mismatches" tool from Admin Tools.

## Bulk operations

Creating many users at once isn't supported via the UI. Two options:

- **Manual creation** one at a time. Tedious but reliable.
- **Direct SQL** via Super Admin tools (Database admin → query) for power users. Not recommended unless you really know what you're doing.

## Password resets

When you reset a user's password:

1. Use the **Reset Password** button on the user record.
2. The temporary password you enter is hashed and stored.
3. Tell the user the temporary password through a secure channel (in person, encrypted email, phone).
4. The user signs in with the temporary password.
5. They change it (or you can ask them to).

If a user forgets their password again, repeat.

## Demo viewer

There's a special account `demo_viewer` that's a read-only Super Admin (the middleware blocks all mutations). It's used for client demos, screenshots, training videos. Don't delete it.

If you need to refresh the demo viewer's password, run `node scripts/create-demo-user.js`.

## Pro tips

- **Use consistent usernames.** Pattern your usernames so anyone can guess them. Examples: `LogisX-XXXX` for drivers, last name for dispatchers, `<company>.<role>` for investors.
- **Set strong initial passwords.** Even temporary passwords should be at least 12 characters with mix of cases, numbers, symbols.
- **Audit user accounts quarterly.** Disable or delete accounts that haven't signed in for 6+ months. They're attack surface.
- **Don't share Super Admin credentials.** Each Super Admin should have their own account, not a shared one. The audit trail relies on individual accountability.
