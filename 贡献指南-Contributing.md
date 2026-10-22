# Contributing

Author and maintainer: **miao010625**.

Open an issue describing the expected behavior, actual result, and a small
synthetic reproduction. Do not post integration secrets, database/calendar IDs,
personal event names, screenshots containing appointments, or private API responses.

For changes, add a regression test and run `npm test` with Node.js 22 or 24.
Use a separate test calendar for manual Apps Script checks. State whether you ran
simulated tests, a read-only preview, or a live write against your own test calendar.
Keep synchronization one-way and preserve unrelated events and historical data.

Do not add email/weather features to the sync core without discussing the scope.
