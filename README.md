# Basera — deployable build

Basera includes a React prototype and a small Node.js API. The browser UI can
still be served statically, while accounts, OTP verification, subscriptions,
listings and community posts use the API.

## Run the backend locally

Use Node.js 18 or newer. In one terminal run `npm run backend:demo` to start
the API on `http://localhost:3001`; in another serve the project with your
usual static development server. Demo mode returns an OTP in the UI and is for
local development only. For a non-demo process use `npm run backend`; OTPs
are generated and verified server-side, but delivery must be connected to an
SMS provider before real users can sign in. Set `PORT` to change the API port
and `BASERA_DB_FILE` to move its JSON data file. The default data file is
`backend/data.json` (created on first write).

The frontend uses `http://localhost:3001/api` by default. Set
`VITE_API_URL` to the deployed API base URL when building for another host.
The existing demo payment modal does not process real payments; connect a
payment provider and verify its server-side webhook before treating a plan as
paid. For production, use a managed database, HTTPS, restricted CORS, provider
rate limits, and a durable session store.

## Deploy
Upload the `dist/` folder to Netlify / Vercel / GitHub Pages / any static host,
or try locally: `cd dist && python3 -m http.server` and open the printed URL.

## Rebuild from source
```
npm install
npm run build
```
The `dist/` in this zip is already built from the current source. It was built
offline with the same Lucide glyphs via `react-icons` (`npm run build:offline`,
which aliases `lucide-react` to `build/offline-icons.jsx`); `npm run build` uses
`lucide-react` directly.

## Architecture update (v1.2) — role + category

The app is now built around **who you are**, chosen on the login page:

1. **Role:** Tenant or Owner.
2. **Category:** Student or Professional (tenants: "I am a…"; owners: "I list for…").
3. Phone number + OTP.

Role and category are saved on the account (`persona` field; older accounts without one are treated as Student) and drive everything after login. There is no longer a Students/Professionals toggle in the header; it is shown as a fixed badge instead.

| | Tenant | Owner |
|---|---|---|
| Navigation | Rooms, Roommates, Living, Partners | Market, My properties |
| Rooms / Market | Listings for their category, filters, saved hearts, nearby, personalised picks | Same market view for their category (to price competitively), no hearts / picks |
| Category effect | Student: campus distance, study-style matching, college partners, student living services. Professional: city-centre distance, WFH filter, work-style matching, company partners, relocation and co-working services | New listings default to "Students" or "Working professionals" |
| Detail popup | Reserve room, agreement, reviews, map paywall + direct contact | "Owner view" (no reserve/review) |
| Subscription | Unlocks map + direct contact | Required to publish |

**Login rules:** you must log in through the same role and category you signed up with. If not, the error tells you exactly what your number is registered as. The logic lives in `src/accounts.mjs` (unit-tested in `tests/accounts.test.mjs`).

## UI/UX update (v1.1)

Design system taken from the new interaction spec and applied across the whole app:

- **Cursor-tracked card glow.** Every pinned-notice card (listings, plans, movers, partners, matches...) gets an ambient marigold glow that follows the mouse, lifts 3px, straightens its tilt and shows a marigold border on hover. Keyboard focus shows the same glow.
- **Listing cards redesigned**: 176px cover photo with smooth zoom on hover, gradient overlay, AC / BHK badge on the photo, "Featured" stamp, heart button, review count and a "View details" call-to-action. Sample listings get cover photos; owner-uploaded photos always take priority; a house icon shows if an image can't load.
- **Saved listings.** Heart button on each card (persisted per browser) and a "Saved (n)" filter.
- **Search bar** for locality / landmark / listing name, inside a new rounded filter panel with a "Curated listings" header and live count.
- **Glowing category navigation**: nav pills lift and glow on hover, active tab is highlighted; nav sits under a divider line in the hero with a pulsing "live" dot.
- **Buttons**: consistent lift + glow + brightness on hover, press-down on click. Icon buttons scale with a glow. Links turn marigold on hover.
- **Form fields**: marigold underline on hover/focus.
- **Refreshed dark mode** palette (deep navy) with matching glow tokens; first visit follows the system light/dark setting, then remembers your choice. `<html data-theme>` is kept in sync so there is no light flash.
- **Detail modal** now opens with a cover image (or your uploaded gallery).
- **Mobile**: safe-area padding for notches / home bar.
- **Accessibility**: clickable cards are keyboard-operable (Enter/Space), aria labels, `aria-pressed` on hearts, `aria-current` on the active tab, and `prefers-reduced-motion` disables all motion effects.

Everything from the previous update (phone OTP login, photo uploads, map paywall, AC filter) is unchanged.

## What changed in the previous update

1. **Phone number + OTP login** (no email/password). Numbers are normalized
   (`+91XXXXXXXXXX`) so different formats map to one account. OTP expires in
   5 min, resend cooldown is 30 s, and after 5 wrong tries a new code is
   required. The session persists across refresh; logout clears it.
   There is no SMS backend in this static app, so the code is shown on screen in
   a labelled "Demo mode" box. For production, replace `sendOtpToPhone` and
   `verifyOtpWithBackend` in `src/App.jsx` with calls to a real backend + SMS
   provider (Twilio, MSG91, Firebase...).
2. **Owner flat photos + dimensions.** "List a place" has BHK/RK type, carpet /
   built-up / super built-up area (negative values rejected) and a multi-photo
   uploader (max 10, auto-compressed, first = Primary). Shown on property cards
   and in the detail gallery.
3. **Map paywall.** Tenants browse for free. Without a subscription they see only
   the approximate location (area/locality) and an "Unlock map & direct contact"
   popup. Subscribed tenants get the map and a "Contact owner directly" (`tel:`)
   button. Owners still need a subscription to publish listings.
4. **Bug fixes.** Listings (with photos) now persist across refresh; owners see
   their own listings after logging in again; large photos are downscaled so they
   fit in browser storage.

## Limitations
- No server: accounts, subscriptions and listings live in each visitor's own
  browser (`localStorage`). Real OTP delivery, payments, and the "3 free
  contacts" credit accounting with atomic server-side enforcement need a backend
  and were not built.
- Subscribing is a demo action (no real payment).
- Photos are stored in `localStorage`; use object storage (S3/R2) in production.
