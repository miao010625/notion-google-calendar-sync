# Notion Calendar Sync

**Author and maintainer: [miao010625](https://github.com/miao010625)**

A configurable **one-way Notion → Google Calendar synchronizer** for Google Apps Script. It creates events, updates titles and dates, handles all-day and timed events, and optionally removes events whose Notion pages are confirmed to be in the trash.

The project contains only calendar synchronization. It has no weather, email, location tracking, or personal account configuration.

## Behavior

- **Preview by default:** `DRY_RUN` defaults to `true`; `previewSync()` always performs a read-only preview.
- **Owned events only:** private Calendar tags identify this installation's events. Unrelated events are not modified.
- **No duplicate inserts after ambiguous responses:** stable event IDs and recovery checks protect repeated runs.
- **All-day events:** shown as free; reminders are disabled unless calendar-default all-day reminders are explicitly selected.
- **Timed events:** shown as busy and use calendar-default reminders. Missing end times use a configurable duration.
- **Multi-day dates:** Notion's inclusive end date becomes Google Calendar's exclusive end date.
- **Historical boundary:** source events before `SYNC_FROM_DATE` are skipped; older Calendar events are preserved during deletion.
- **Conservative deletion:** disabled by default. Missing rows, Notion 404s, and permission failures do not authorize deletion.
- **Bounded execution:** paginated reads finish before writes begin; write counts, retries, delays, and runtime limits prevent unbounded execution.
- **Private configuration:** credentials and account IDs live in Apps Script's Script Properties, not in source files.

## Prerequisites

1. A Google account with edit access to the destination calendar.
2. A Notion internal integration with **Read content** permission, connected to the source database.
3. A Notion **Date** property. Formula or rollup date properties are not supported.

Start with a **new test calendar**. This is a standalone public edition: it does not adopt events or mappings created by older scripts, and it does not alter an existing deployed script. Do not run two synchronizers against the same destination without reviewing their behavior.

## Install in Google Apps Script

1. Download this repository's ZIP or clone it:

   ```sh
   git clone https://github.com/miao010625/notion-google-calendar-sync.git
   ```

2. Open [Google Apps Script](https://script.google.com/), create a standalone project, and copy the contents of [`src/日历同步-Calendar-sync.gs`](src/日历同步-Calendar-sync.gs) into a script file.
3. Under **Services → Add a service**, enable **Google Calendar API**, version **v3**, with identifier **Calendar**.
4. Under **Project Settings**, enable **Show appsscript.json manifest file**. Replace that manifest's contents with [`src/appsscript.json`](src/appsscript.json). Its default project timezone is UTC; synchronized events use the configured/calendar timezone.
5. If using a standard Google Cloud project rather than the default Apps Script project, also enable the Google Calendar API in that Cloud project.
6. Add the Script Properties described below. Do not paste credentials into the code or commit an exported properties file.
7. Run `previewSync()`, review Google's authorization screen, and approve the permissions for your own project. Preview reads Notion and Calendar but does not create, update, or delete events or properties.
8. Inspect the execution log. It contains operation counts, not event names or token values.
9. When ready, set **`DRY_RUN=false`**, run `syncNotionToGoogle()` once, and inspect the test calendar.
10. Optionally run `installSyncTrigger()` for a 10-minute scheduled sync. Trigger execution times are approximate. Run `removeSyncTriggers()` to stop automation without deleting events.

No hosted server, public web-app deployment, or Google OAuth credentials file is required. Authorization belongs to the Google account running your Apps Script project.

## Script Properties

Open **Project Settings → Script Properties → Add script property**. Values are strings.

| Property | Required/default | Purpose |
| --- | --- | --- |
| `NOTION_TOKEN` | Required | Your Notion integration secret; never share it |
| `NOTION_DATA_SOURCE_ID` | Recommended | Data source UUID, with or without hyphens |
| `NOTION_DATABASE_ID` | Alternative | Database UUID; auto-selection is allowed only when exactly one data source exists |
| `GOOGLE_CALENDAR_ID` | Required | Destination Calendar ID; `primary` is accepted only when explicitly entered |
| `SYNC_FROM_DATE` | Required | Real date in `YYYY-MM-DD` form, chosen by you |
| `NOTION_DATE_PROPERTY` | `Date` | Exact, case-sensitive Notion Date property name |
| `TIME_ZONE` | Calendar timezone | IANA timezone used for date boundaries and timestamps without an explicit zone |
| `DRY_RUN` | `true` | Only the literal `false` enables writes |
| `DELETE_ARCHIVED` | `false` | Permit deletion only after an accessible Notion page is confirmed trashed/archived |
| `ALL_DAY_DEFAULT_REMINDERS` | `false` | Use Calendar's default all-day reminders instead of disabling them |
| `DEFAULT_DURATION_MINUTES` | `60` | Timed-event fallback duration, 1–1440 minutes |
| `MAX_WRITES_PER_RUN` | `10` | Maximum Calendar operation attempts, 1–100 |
| `WRITE_GAP_MS` | `1500` | Delay between attempts, 0–10000 milliseconds |
| `NOTION_API_VERSION` | `2026-03-11` | Explicit Notion API version header |

Use [`examples/配置示例-Example-properties.json`](examples/配置示例-Example-properties.json) as a **reference**; replace its placeholders only in your private Script Properties. The script does not automatically read this JSON file.

Find the Calendar ID in **Google Calendar → Settings → your calendar → Integrate calendar**. A Notion database ID and data source ID are different identifiers. If unsure, provide `NOTION_DATABASE_ID`; the script will require an explicit source ID when a database has multiple sources. A Notion URL is not accepted in an ID property.

The title is taken from the page's title property automatically. Dates without times create all-day events. Dates with explicit offsets preserve their instant; timestamps without offsets use the Notion date property's timezone, or the configured Calendar timezone.

## Preview and deletion

Example log:

```json
{"preview":true,"created":2,"updated":1,"deleted":0,"unchanged":4,"skipped":0,"deferred":0}
```

In preview, these are **planned** counts. In apply mode they count completed operations. `deferred` means another run is needed after the write/runtime budget is exhausted. Writes are incremental, not an atomic transaction.

Deleting/clearing a Notion date does **not** delete its existing Calendar event. Moving a page to another data source or losing access to it also preserves the event. With `DELETE_ARCHIVED=true`, only a confirmed trashed/archived source page can remove an owned Calendar event within the configured date range. Trash access may be denied by Notion; the script then preserves the event and increments `skipped`.

This intentionally favors preservation. It does not indiscriminately remove all events that disappear from a filtered database view. Recurring events are not supported and are never edited as ordinary owned events.

All-day reminders use Calendar's defaults when enabled; this edition does not create separate 10:30 reminder-copy events. Review your calendar notification settings before enabling default reminders.

## Permissions and privacy

The manifest requests Calendar event read/write access, Calendar metadata read access, external requests to Notion, and trigger management. Only configure a database/calendar you are authorized to use. Do not invite untrusted editors to your Apps Script project: editors can access its Script Properties.

No credentials, database IDs, email addresses, geographical coordinates, or copied personal events are shipped. Test data is synthetic. Logs omit event titles and raw private API response bodies. Synced Calendar events contain their own Notion page link, visible to people who can view those Calendar event details.

## Testing

Requires Node.js **22 or 24**; no npm packages or live credentials are needed:

```sh
npm test
# or
node --test tests/同步测试-Sync-tests.cjs
```

The suite executes the Apps Script code with simulated Google/Notion service boundaries. It covers preview behavior, date conversion, idempotency, pagination failures, ownership, deletion opt-in, permission failures, write budgets, lost responses, and privacy. CI runs on Windows and Linux. These tests are not a claim of live authorization or production API validation; perform the preview/test-calendar installation steps in your own account.

## Troubleshooting

- **Missing Script Property:** add the exact property name in Project Settings.
- **Notion HTTP 401/403/404:** verify the integration secret, database connection, and identifier type. Do not post the private response or secret publicly.
- **Calendar unavailable / `Calendar is not defined`:** enable the advanced Calendar service and verify your account has access.
- **No planned events:** check the Date property name, source, and `SYNC_FROM_DATE`; empty titles/dates and invalid timestamps are skipped.
- **No events created:** ensure you intentionally changed `DRY_RUN` to the exact string `false`.
- **Writes deferred:** run again later or wait for the next trigger; inspect quotas before increasing the write limit.
- **Previous personal script still runs:** disable its triggers separately. This edition removes only its own `syncNotionToGoogle` triggers in the current project.

## References

- [Notion data source query](https://developers.notion.com/reference/query-a-data-source)
- [Notion API versioning](https://developers.notion.com/reference/versioning)
- [Google Calendar event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)

## Contributing and license

See [contributing](贡献指南-Contributing.md) and [security](安全说明-Security.md).
MIT License, copyright © 2026 **miao010625**. See [LICENSE](LICENSE).
