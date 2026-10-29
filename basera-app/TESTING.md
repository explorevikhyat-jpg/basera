# Test cases — AC / Non-AC option

Automated (run `npm test`, Node 18+, no install needed) — `tests/ac-filter.test.mjs`
1. Filter options exposed to the UI are Any / AC / Non-AC.
2. `normalizeAc` accepts "AC", "ac", " Ac ", true and "Non-AC", "non-ac", "NON AC", "non_ac", "nonac", false.
3. Missing / unknown values (undefined, null, "", "maybe", 0) are treated as "not specified".
4. Filter "Any" (or empty) returns every listing.
5. Filter "AC" returns only listings explicitly set to AC.
6. Filter "Non-AC" returns only listings explicitly set to Non-AC.
7. Listings with no AC info never match "AC" or "Non-AC".
8. AC and Non-AC results never overlap.
9. A null/undefined listing never throws.

Manual / browser (verified in a headless browser on the built page)
- Log in as the seeded student (9000000001): the Rooms tab shows an "AC / Non-AC" dropdown. Delhi NCR: 8 listings -> AC 4 -> Non-AC 4 -> Any 8, no overlap, cards show an AC or NON-AC badge.
- Log in as the seeded owner (9000000002) -> List a place: the form has an "AC / Non-AC (not specified)" dropdown. Create a listing as Non-AC, refresh: it appears under Non-AC, not under AC, with a Non-AC badge on the card and in the detail view.
- Leaving the dropdown as "not specified" hides the listing from both AC and Non-AC filters but keeps it under "Any".
- Existing browsers with older saved listings get the AC value filled in for the sample listings automatically.


# Test cases — role + category architecture

Automated (`npm test`) — `tests/accounts.test.mjs`
1. Exactly two roles (Tenant/Owner) and two categories (Student/Professional).
2. Role/category normalisation, including legacy accounts with no category (-> Student).
3. Login succeeds only with the matching role AND category; mismatches explain the registered combination.
4. Navigation is role-specific (tenant: 4 sections, owner: 2); tenants cannot reach "My properties", owners cannot reach Roommates.
5. Owner's default listing audience follows their category.

Manual / browser (verified in headless Chromium against the built page)
- Sign up Tenant/Professional: nav = Rooms, Roommates, Living, Partners; badge "Tenant Professional"; company partners; "Work style" in roommate form; student-only listings hidden.
- Log in with wrong category or wrong role: blocked with a clear message. Correct combination: logs in.
- Sign up Tenant/Student: college partners, student-visible listings.
- Sign up Owner/Professional: subscription gate, then nav = Market, My properties; no hearts/saved/personalised picks; detail popup shows "Owner view"; "List your property" defaults preferred tenants to Working professionals.
