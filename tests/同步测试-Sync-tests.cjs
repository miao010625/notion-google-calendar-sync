'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const file = path.join(__dirname, '../src/日历同步-Calendar-sync.gs');
const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const pageId = '11111111-1111-1111-1111-111111111111';
const dataId = '22222222222222222222222222222222';
const copy = (value) => JSON.parse(JSON.stringify(value));

function fixture(overrides = {}) {
  const saved = { NOTION_TOKEN: 'synthetic-test-token', NOTION_DATA_SOURCE_ID: dataId,
    GOOGLE_CALENDAR_ID: 'synthetic-calendar', SYNC_FROM_DATE: '2026-01-01',
    TIME_ZONE: 'UTC', WRITE_GAP_MS: '0', ...overrides };
  const rows = [{ object: 'page', id: pageId, properties: {
    Name: { type: 'title', title: [{ plain_text: 'Example task' }] },
    Date: { type: 'date', date: { start: '2026-10-22', end: null } },
  } }];
  const events = new Map();
  const calls = [];
  const logs = [];
  const props = { getProperties: () => ({ ...saved }), getProperty: (k) => saved[k] || null,
    setProperty: (k, v) => { saved[k] = v; calls.push('property'); } };
  const context = {
    Date, JSON, Math, Object, Array, String, Number, Error, RegExp, Set, Map,
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Logger: { log: (s) => logs.push(s) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
      sleep() {}, getUuid: () => '33333333-3333-3333-3333-333333333333',
      formatDate: (d, zone, pattern) => {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric',
          month: '2-digit', day: '2-digit' }).formatToParts(d);
        const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
        return `${p.year}-${p.month}-${p.day}`;
      },
      parseDate: (text, zone) => {
        if (zone !== 'UTC') throw new Error('Test fixture only parses naive UTC dates');
        return new Date(text.endsWith('Z') ? text : text + 'Z');
      },
    },
    Calendar: {
      Calendars: { get: () => ({ timeZone: 'UTC' }) },
      Events: {
        list: () => ({ items: [...events.values()].filter((e) => e.status !== 'cancelled').map(copy) }),
        get: (_, id) => {
          if (!events.has(id)) throw new Error('404 not found');
          return copy(events.get(id));
        },
        insert: (body) => {
          calls.push('insert');
          if (events.has(body.id)) throw new Error('409 conflict');
          events.set(body.id, copy(body));
          return copy(body);
        },
        patch: (body, _, id) => {
          calls.push('patch');
          const next = { ...events.get(id), ...copy(body), id };
          events.set(id, next);
          return copy(next);
        },
        remove: (_, id) => { calls.push('remove'); events.delete(id); },
      },
    },
    UrlFetchApp: { fetch: (url, options) => {
      let body;
      if (url.endsWith('/query')) body = { object: 'list', results: copy(rows), has_more: false, next_cursor: null };
      else if (url.includes('/pages/')) body = { object: 'page', id: pageId, in_trash: true };
      else body = { object: 'data_source', id: dataId, properties: { Date: { type: 'date' } } };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) };
    } },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'CalendarSync.gs' });
  return { c: context, saved, rows, events, calls, logs };
}

test('the installable Apps Script file exists', () => assert.ok(source.length > 0));
const check = (name, fn) => test(name, { skip: !source }, fn);

check('preview never writes events or script properties', () => {
  const f = fixture(); f.c.previewSync(); assert.deepEqual(f.calls, []);
});
check('scheduled synchronization is dry-run by default', () => {
  const f = fixture(); f.c.syncNotionToGoogle(); assert.deepEqual(f.calls, []);
});
check('apply creates once and repeated synchronization is idempotent', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.syncNotionToGoogle(); f.c.syncNotionToGoogle();
  assert.deepEqual(f.calls.filter((x) => x !== 'property'), ['insert']);
  assert.equal(f.events.size, 1);
});
check('Notion inclusive multi-day end becomes an exclusive Calendar end', () => {
  const f = fixture({ DRY_RUN: 'false' });
  f.rows[0].properties.Date.date.end = '2026-10-24'; f.c.syncNotionToGoogle();
  const e = [...f.events.values()][0]; assert.equal(e.end.date, '2026-10-25');
  assert.equal(e.transparency, 'transparent'); assert.equal(e.reminders.useDefault, false);
});
check('timed events without an end use the configured duration', () => {
  const f = fixture({ DRY_RUN: 'false', DEFAULT_DURATION_MINUTES: '45' });
  f.rows[0].properties.Date.date.start = '2026-10-22T10:00:00+09:00'; f.c.syncNotionToGoogle();
  const e = [...f.events.values()][0]; assert.equal(e.end.dateTime, '2026-10-22T01:45:00.000Z');
});
check('title changes update the existing event instead of creating another', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.syncNotionToGoogle();
  f.rows[0].properties.Name.title[0].plain_text = 'Updated'; f.c.syncNotionToGoogle();
  assert.equal([...f.events.values()][0].summary, 'Updated'); assert.equal(f.events.size, 1);
});
check('missing Notion dates preserve existing Calendar events', () => {
  const f = fixture({ DRY_RUN: 'false', DELETE_ARCHIVED: 'true' }); f.c.syncNotionToGoogle();
  f.rows[0].properties.Date.date = null; f.c.syncNotionToGoogle(); assert.equal(f.events.size, 1);
});
check('events older than the configured boundary remain untouched', () => {
  const f = fixture({ DRY_RUN: 'false', DELETE_ARCHIVED: 'true' }); f.c.syncNotionToGoogle();
  f.saved.SYNC_FROM_DATE = '2027-01-01'; f.rows.length = 0;
  f.c.syncNotionToGoogle(); assert.equal(f.events.size, 1);
});
check('deletion is disabled by default even for archived pages', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.syncNotionToGoogle();
  f.rows.length = 0; f.c.syncNotionToGoogle(); assert.equal(f.events.size, 1);
});
check('opt-in deletion requires a confirmed archived page', () => {
  const f = fixture({ DRY_RUN: 'false', DELETE_ARCHIVED: 'true' }); f.c.syncNotionToGoogle();
  f.rows.length = 0; f.c.syncNotionToGoogle(); assert.equal(f.events.size, 0);
});
check('a Notion permission failure never becomes a delete', () => {
  const f = fixture({ DRY_RUN: 'false', DELETE_ARCHIVED: 'true' }); f.c.syncNotionToGoogle(); f.rows.length = 0;
  const original = f.c.UrlFetchApp.fetch;
  f.c.UrlFetchApp.fetch = (url, options) => url.includes('/pages/')
    ? { getResponseCode: () => 404, getContentText: () => '{}', getHeaders: () => ({}) }
    : original(url, options);
  f.c.syncNotionToGoogle(); assert.equal(f.events.size, 1);
});
check('incomplete pagination stops before any Calendar write', () => {
  const f = fixture({ DRY_RUN: 'false' }); const original = f.c.UrlFetchApp.fetch;
  f.c.UrlFetchApp.fetch = (url, options) => url.endsWith('/query')
    ? { getResponseCode: () => 200, getContentText: () => JSON.stringify({ results: f.rows, has_more: true, next_cursor: null }) }
    : original(url, options);
  assert.throws(() => f.c.syncNotionToGoogle(), /pagination/i); assert.deepEqual(f.calls, []);
});
check('unowned events returned unexpectedly are never changed', () => {
  const f = fixture({ DRY_RUN: 'false', DELETE_ARCHIVED: 'true' });
  f.events.set('other', { id: 'other', summary: 'Private unrelated event', start: { date: '2026-10-22' } });
  f.c.syncNotionToGoogle(); assert.equal(f.events.get('other').summary, 'Private unrelated event');
  assert.ok(!f.calls.includes('remove'));
});
check('invalid boolean configuration cannot enable writes', () => {
  const f = fixture({ DRY_RUN: 'no' }); assert.throws(() => f.c.syncNotionToGoogle(), /true or false/i);
  assert.deepEqual(f.calls, []);
});
check('invalid calendar dates never create events', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.rows[0].properties.Date.date.start = '2026-02-30';
  f.c.syncNotionToGoogle(); assert.equal(f.events.size, 0);
});
check('write budgets defer remaining operations', () => {
  const f = fixture({ DRY_RUN: 'false', MAX_WRITES_PER_RUN: '1' });
  const second = copy(f.rows[0]); second.id = '44444444-4444-4444-4444-444444444444'; f.rows.push(second);
  const report = f.c.syncNotionToGoogle(); assert.equal(f.events.size, 1); assert.equal(report.deferred, 1);
});
check('credentials and event titles are omitted from logs', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.syncNotionToGoogle();
  assert.ok(!f.logs.join('').includes(f.saved.NOTION_TOKEN)); assert.ok(!f.logs.join('').includes('Example task'));
});

check('forced preview is read-only even after DRY_RUN=false', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.previewSync(); assert.deepEqual(f.calls, []);
});
check('a lost insert response does not create duplicate events', () => {
  const f = fixture({ DRY_RUN: 'false' }); const original = f.c.Calendar.Events.insert;
  f.c.Calendar.Events.insert = (...args) => { original(...args); throw new Error('timeout'); };
  f.c.syncNotionToGoogle(); f.c.syncNotionToGoogle(); assert.equal(f.events.size, 1);
  assert.equal(f.calls.filter((x) => x === 'insert').length, 1);
});
check('manually deleted events get a fresh reserved ID', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.syncNotionToGoogle();
  const old = [...f.events.values()][0]; f.events.set(old.id, { ...old, status: 'cancelled' });
  f.c.syncNotionToGoogle(); const live = [...f.events.values()].filter((e) => e.status !== 'cancelled');
  assert.equal(live.length, 1); assert.notEqual(live[0].id, old.id);
  f.c.syncNotionToGoogle(); assert.equal(f.calls.filter((x) => x === 'insert').length, 2);
});
check('date moves update the original event', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.syncNotionToGoogle();
  const id = [...f.events.keys()][0]; f.rows[0].properties.Date.date.start = '2026-11-05';
  f.c.syncNotionToGoogle(); assert.equal(f.events.get(id).start.date, '2026-11-05');
});
check('all-day to timed conversion clears the old date field', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.syncNotionToGoogle();
  f.rows[0].properties.Date.date.start = '2026-10-22T10:00:00Z'; f.c.syncNotionToGoogle();
  const e = [...f.events.values()][0]; assert.equal(e.start.date, null);
  assert.equal(e.start.dateTime, '2026-10-22T10:00:00.000Z'); assert.equal(e.reminders.useDefault, true);
});
check('Notion 429 retries without exposing the response body', () => {
  const f = fixture({ DRY_RUN: 'false' }); const original = f.c.UrlFetchApp.fetch; let reads = 0;
  f.c.UrlFetchApp.fetch = (...args) => ++reads === 1 ? {
    getResponseCode: () => 429, getContentText: () => 'PRIVATE RESPONSE',
    getHeaders: () => ({ 'Retry-After': '1' }),
  } : original(...args);
  f.c.syncNotionToGoogle(); assert.equal(f.events.size, 1);
  assert.ok(!f.logs.join('').includes('PRIVATE RESPONSE'));
});
check('Calendar snapshot failures stop before writes', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.c.Calendar.Events.list = () => { throw new Error('quota'); };
  assert.throws(() => f.c.syncNotionToGoogle(), /snapshot failed/i); assert.deepEqual(f.calls, []);
});
check('database ambiguity requires an explicit data source', () => {
  const f = fixture({ NOTION_DATA_SOURCE_ID: '', NOTION_DATABASE_ID: dataId, DRY_RUN: 'false' });
  f.c.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ data_sources: [{ id: dataId }, { id: pageId }] }) });
  assert.throws(() => f.c.syncNotionToGoogle(), /exactly one/i); assert.deepEqual(f.calls, []);
});
check('leap-day single events end on the next calendar day', () => {
  const f = fixture({ DRY_RUN: 'false' }); f.rows[0].properties.Date.date.start = '2028-02-29';
  f.c.syncNotionToGoogle(); assert.equal([...f.events.values()][0].end.date, '2028-03-01');
});
