# Frequently Asked Questions

Questions drivers ask most often, in no particular order. Skim for yours.

## About the app itself

**Q. Do I need to install anything?**
No. LogisX runs in your phone's browser. Go to `app.logisx.com` and sign in.

**Q. Does the app work offline?**
Mostly no. Some local state is cached (the app doesn't go totally blank when signal drops), but anything that needs to talk to the server — accepting a load, sending a message, uploading a POD — needs at least some connection. Position reports are queued and sent in batch when signal returns.

**Q. Will the app run in the background?**
Sort of. When the LogisX tab is open but in the background (another app is in front), the phone may slow down GPS reporting to save battery. Keep the tab in front while you're on a load if you can.

**Q. Does it work on a tablet?**
Yes. The layout adapts to larger screens. Many drivers prefer a 7-10 inch tablet on a dash mount over their phone.

**Q. Can I use the app on a laptop or desktop?**
Yes, but you won't be able to report GPS (laptops have no GPS) so the position-tracking features won't work. Sign in from a laptop is fine for reading messages, reviewing invoices, etc.

**Q. Will I get push notifications on my phone?**
No, not in the traditional OS-level sense. The app shows in-app notifications (badges, banners) when you have it open. For urgent stuff, dispatch will call.

## About loads and pay

**Q. Can I see other drivers' loads?**
No. You see only your own.

**Q. Can I see what dispatch sees on the tracking map?**
No. The dispatcher's tracking view is for their workflow.

**Q. How is my pay calculated?**
Either $250 per unique active day (daily-rate drivers) or a percentage of load revenue (owner-operators). Check your contract for which applies and at what rate.

**Q. What's an "active day"?**
For daily-rate pay: any calendar day you spent some portion of on a load. Pickup Monday + delivery Wednesday = 3 active days. Three short loads all on Thursday = 1 active day.

**Q. What if a load spans midnight?**
Each calendar day touched counts. A pickup at 11 PM Monday and a delivery at 2 AM Wednesday is Monday + Tuesday + Wednesday = 3 days, even though it took only 27 hours.

**Q. Can I decline a load without consequences?**
Generally yes, if you have a legitimate reason (HOS, equipment problem, schedule conflict). Repeated unexplained declines may affect future assignments. Be honest with dispatch when you decline.

**Q. What if my truck breaks down mid-load?**
Call dispatch. They'll either arrange repair or reassign the load to another driver. You may need to deliver the trailer to the new driver's location for transfer.

**Q. Can I take loads I find myself (e.g., from a load board)?**
No. LogisX assigns loads. Independent load-finding isn't part of the workflow.

**Q. Why does the app sometimes show the rate and sometimes not?**
Rate visibility depends on configuration. Some companies show rates to drivers (you see what the broker paid); others don't. Ask your administrator if you're unsure.

## About status and GPS

**Q. Why didn't my status auto-advance when I arrived?**
The geofence missed. Common at urban or industrial sites with weak GPS. Update manually.

**Q. Why did my status auto-advance when I wasn't there?**
You probably drove through the geofence (a gas station or truck stop next to the location). Update back manually if the status is wrong.

**Q. Can dispatch see where I am all the time?**
While you're signed in and have a load accepted, yes. When you're signed out or have no active load, no. The app reports GPS only during active work.

**Q. Does the app track me when I'm off duty?**
No. Once your status is "Delivered" or "POD Received" and the load is closed, GPS reporting stops. Outside of an active load, no GPS reporting happens.

**Q. What if I forget to sign out?**
Doesn't matter. The app only tracks GPS during active loads. Being signed in with no active load doesn't trigger position reports.

**Q. Why does my position bounce around on the map?**
Probably GPS error in marginal signal areas (canyons, urban centers, near big buildings). The map smooths it as much as possible; some bouncing is unavoidable.

## About documents

**Q. Can I download my truck's documents to my phone?**
No, by design. You can view them in the app whenever you need to.

**Q. Will an officer accept the documents on my phone?**
In most states, yes. Federal regulations explicitly allow electronic display. A few officers still prefer paper — keep paper as backup.

**Q. The documents list is empty.**
Either no documents have been uploaded for your truck, or none are flagged driver-visible. Message dispatch.

**Q. The registration on the app expired. What do I do?**
Don't drive on an expired registration. Message dispatch — they may have a newer version that just isn't uploaded yet.

**Q. I switched trucks today. Why are the documents the same?**
The app updates the document list when your truck assignment changes. If you're not seeing the new documents, refresh the page or sign out and back in.

## About expenses

**Q. Do I have to log every expense?**
Anything you want reimbursed, yes. Personal expenses (your food, motel, etc.) don't go in the app.

**Q. The AI got my receipt wrong. Why?**
Receipt OCR works best on clear, well-lit, flat photos. Crumpled or faded receipts can mislead it. Edit the field; the AI is a starting point, not a replacement for you.

**Q. Can I edit an expense after I save it?**
No. Submit a new one and ask dispatch to reject the wrong one.

**Q. How long until my expense is reimbursed?**
Approved expenses are reimbursed on your weekly invoice. The cadence is the same as your pay.

**Q. Are tolls automatically tracked?**
If your truck has an automatic toll device (E-ZPass, etc.) the tolls go through the device and you don't log them. If you pay cash, log it.

## About messaging

**Q. Can I message other drivers?**
No. Messaging is between you and dispatch only.

**Q. What if my dispatcher is off-duty?**
A different dispatcher covers their off hours. Send your message to the dispatch channel and whoever is on duty will pick it up.

**Q. Are messages logged?**
Yes. Every message is stored in the database. Dispatch and admin can review historical messages.

**Q. Can I delete a message I sent?**
No. Once sent, it stays.

## About onboarding

**Q. How long does onboarding take?**
Variable. Document signing is about 30 minutes. The drug test depends on when the appointment slot is available. FMCSA Clearinghouse enrollment is yours to complete. Training varies by course. Most drivers complete onboarding in 1-3 days.

**Q. Can I run loads while onboarding is incomplete?**
No. The lock screen blocks everything until onboarding is done.

**Q. Why so many forms?**
Each form is required for legal, regulatory, or insurance reasons. The independent contractor agreement is the master contract; the policies cover specific behaviors; FMCSA consent is federally required. None are decorative.

## About safety and HOS

**Q. Does the app track my hours of service (HOS)?**
Not currently. HOS is tracked by your ELD (typically Routemate or similar hardware in the truck). The LogisX app shows where you are and what status your load is in; it doesn't manage your duty time.

**Q. What if I'm running out of HOS?**
Park somewhere safe and finish the load tomorrow. Message dispatch with your expected restart time. They can adjust the load schedule with the broker.

**Q. Can dispatch see my HOS?**
Through the ELD integration, yes — they can see your drive time, on-duty time, and remaining hours.

## About the company

**Q. Who do I talk to about something not related to dispatch?**
HR questions, payroll questions, benefits questions — talk to your administrator (the person who handles onboarding and admin tasks). Their contact info was in your welcome email.

**Q. Who is the CEO?**
Deshorn King.

**Q. What if I want to give feedback about the app itself?**
Tell dispatch. They'll relay it. The app is actively developed and feedback from drivers shapes future improvements.

**Q. Can I refer a friend to drive for LogisX?**
Probably yes — most carriers welcome referrals. Ask your administrator about the process.

## Things drivers don't usually ask but should

**Q. What's my username if I forget?**
It's typically a code like `LogisX-XXXX` (the number is unique to you). Your administrator can tell you, or check your welcome email.

**Q. Where can I find a copy of my contractor agreement?**
Sign in, go to **Kit** tab → Documents → look for "Independent Contractor Agreement." Open it, take a screenshot if you want to save it.

**Q. Where can I see my full driving history with LogisX?**
Loads tab → Completed (or filter by date). You'll see every load you've delivered.

**Q. How long are messages and load history kept?**
Indefinitely. Nothing is deleted.

**Q. Can I see my own driver rating?**
Most likely yes — check your profile. Some companies share ratings with drivers; others keep them internal.

That's the most common stuff. If you have a question that's not here, message dispatch or your administrator. Most "how do I…" questions have an answer that's already in the workflow somewhere; we're happy to point you to it.

Good roads.
