/**
 * Notion Calendar Sync — Google Apps Script, authored by miao010625.
 * One-way synchronization. Configure Script Properties; never hard-code secrets.
 * Requires the advanced Calendar service (identifier Calendar, version v3).
 */

function syncNotionToGoogle() { return runSync_(false); }
function previewSync() { return runSync_(true); }

function loadConfig_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  function required(name) {
    const value = String(p[name] || '').trim();
    if (!value) throw new Error('Missing Script Property: ' + name);
    return value;
  }
  function flag(name, fallback) {
    if (p[name] === undefined || p[name] === '') return fallback;
    if (p[name] !== 'true' && p[name] !== 'false') {
      throw new Error(name + ' must be true or false.');
    }
    return p[name] === 'true';
  }
  function integer(name, fallback, minimum, maximum) {
    if (p[name] === undefined || p[name] === '') return fallback;
    const value = Number(p[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error('Invalid numeric Script Property: ' + name);
    }
    return value;
  }
  const from = required('SYNC_FROM_DATE');
  validateDate_(from);
  const source = String(p.NOTION_DATA_SOURCE_ID || '').trim();
  const database = String(p.NOTION_DATABASE_ID || '').trim();
  if (!source && !database) throw new Error('Set NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID.');
  [source, database].filter(Boolean).forEach(normalizeId_);
  return {
    token: required('NOTION_TOKEN'), sourceId: source ? normalizeId_(source) : '',
    databaseId: database ? normalizeId_(database) : '',
    calendarId: required('GOOGLE_CALENDAR_ID'), from: from,
    dateProperty: p.NOTION_DATE_PROPERTY || 'Date',
    version: p.NOTION_API_VERSION || '2026-03-11',
    timeZone: String(p.TIME_ZONE || '').trim(), dryRun: flag('DRY_RUN', true),
    deleteArchived: flag('DELETE_ARCHIVED', false),
    allDayReminders: flag('ALL_DAY_DEFAULT_REMINDERS', false),
    duration: integer('DEFAULT_DURATION_MINUTES', 60, 1, 1440),
    maxWrites: integer('MAX_WRITES_PER_RUN', 10, 1, 100),
    gap: integer('WRITE_GAP_MS', 1500, 0, 10000),
    deadline: Date.now() + 240000,
  };
}

function normalizeId_(id) {
  const clean = String(id).replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(clean)) throw new Error('Expected a Notion UUID, not a URL.');
  return clean;
}

function validateDate_(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid date; use a real YYYY-MM-DD value.');
  }
  return value;
}

function nextDate_(value) {
  validateDate_(value);
  return new Date(Date.parse(value + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
}

function digest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
}

function assertTime_(cfg) {
  if (Date.now() >= cfg.deadline) throw new Error('Runtime budget reached; retry on the next run.');
}

function pause_(cfg, milliseconds) {
  if (Date.now() + milliseconds >= cfg.deadline) throw new Error('Retry exceeds runtime budget.');
  Utilities.sleep(milliseconds);
}

function notion_(cfg, endpoint, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    assertTime_(cfg);
    let response;
    try {
      response = UrlFetchApp.fetch('https://api.notion.com/v1/' + endpoint, {
        method: body ? 'post' : 'get', contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + cfg.token, 'Notion-Version': cfg.version },
        muteHttpExceptions: true,
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (attempt === 3) throw new Error('Notion network request failed; no response body logged.');
      pause_(cfg, Math.pow(2, attempt) * 1000);
      continue;
    }
    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      try { return JSON.parse(response.getContentText()); }
      catch (error) { throw new Error('Notion returned invalid JSON.'); }
    }
    if ((code === 429 || code >= 500) && attempt < 3) {
      const headers = response.getHeaders ? response.getHeaders() : {};
      const seconds = Number(headers['Retry-After'] || headers['retry-after'] || 0);
      pause_(cfg, Math.max(Math.pow(2, attempt) * 1000,
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0));
      continue;
    }
    // Do not expose the token, request URL, or private response body.
    throw new Error('Notion request failed (HTTP ' + code + ').');
  }
  throw new Error('Notion request exhausted its retry budget.');
}

function resolveSource_(cfg) {
  if (cfg.sourceId) return;
  const database = notion_(cfg, 'databases/' + cfg.databaseId);
  const sources = database.data_sources || [];
  if (sources.length !== 1) {
    throw new Error('Database does not have exactly one data source; set NOTION_DATA_SOURCE_ID explicitly.');
  }
  cfg.sourceId = normalizeId_(sources[0].id);
}

function readPages_(cfg) {
  const schema = notion_(cfg, 'data_sources/' + cfg.sourceId);
  if (!schema.properties || !schema.properties[cfg.dateProperty] ||
      schema.properties[cfg.dateProperty].type !== 'date') {
    throw new Error('Configured Notion date property is missing or is not a Date property.');
  }
  const pages = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const result = notion_(cfg, 'data_sources/' + cfg.sourceId + '/query',
      Object.assign({ page_size: 100 }, cursor ? { start_cursor: cursor } : {}));
    if (!Array.isArray(result.results) || typeof result.has_more !== 'boolean') {
      throw new Error('Invalid Notion pagination response.');
    }
    result.results.forEach(function(page) {
      if (!page || page.object !== 'page') throw new Error('Invalid page in Notion response.');
      normalizeId_(page.id);
      pages.push(page);
    });
    cursor = result.has_more ? result.next_cursor : null;
    if (result.has_more && (!cursor || cursors.has(cursor))) {
      throw new Error('Incomplete or repeated Notion pagination cursor.');
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return pages;
}

function readEvents_(cfg) {
  const events = [];
  const cursors = new Set();
  let cursor = null;
  do {
    assertTime_(cfg);
    let result;
    try {
      result = Calendar.Events.list(cfg.calendarId, Object.assign({
        privateExtendedProperty: ['syncOwner=' + cfg.owner], showDeleted: false, maxResults: 2500,
      }, cursor ? { pageToken: cursor } : {}));
    } catch (error) { throw new Error('Calendar event snapshot failed; synchronization stopped.'); }
    (result.items || []).forEach(function(event) {
      const tags = (event.extendedProperties || {}).private || {};
      if (tags.syncOwner === cfg.owner && event.status !== 'cancelled') events.push(event);
    });
    cursor = result.nextPageToken || null;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated Calendar pagination cursor.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return events;
}

function parseInstant_(value, zone) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw new Error('Invalid timed event date.');
  }
  validateDate_(value.slice(0, 10));
  let date;
  if (/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    date = new Date(value);
  } else {
    const clean = value.replace(/\.\d+$/, '');
    const format = clean.length === 16 ? "yyyy-MM-dd'T'HH:mm" : "yyyy-MM-dd'T'HH:mm:ss";
    date = Utilities.parseDate(clean, zone, format);
  }
  if (!date || !Number.isFinite(date.getTime())) throw new Error('Invalid timed event date.');
  return date;
}

function desiredEvent_(page, cfg) {
  const properties = page.properties || {};
  const titleProperty = Object.keys(properties).map(function(key) { return properties[key]; })
    .find(function(prop) { return prop && prop.type === 'title'; });
  const title = titleProperty && Array.isArray(titleProperty.title)
    ? titleProperty.title.map(function(item) { return item.plain_text || (item.text || {}).content || ''; }).join('').trim() : '';
  const date = (properties[cfg.dateProperty] || {}).date;
  if (!title || !date || !date.start) return null;
  const id = normalizeId_(page.id);
  const body = {
    summary: title, description: 'Managed by Notion Calendar Sync. Edit the source in Notion.\nhttps://www.notion.so/' + id,
    extendedProperties: { private: { syncOwner: cfg.owner, notionPage: id } },
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(date.start)) {
    validateDate_(date.start);
    const end = date.end || date.start;
    validateDate_(end);
    if (end < date.start) throw new Error('Event end precedes start.');
    if (date.start < cfg.from) return null;
    body.start = { date: date.start };
    body.end = { date: nextDate_(end) };
    body.transparency = 'transparent';
    body.reminders = cfg.allDayReminders ? { useDefault: true } : { useDefault: false, overrides: [] };
  } else {
    const zone = date.time_zone || cfg.timeZone;
    const start = parseInstant_(date.start, zone);
    const end = date.end ? parseInstant_(date.end, zone) : new Date(start.getTime() + cfg.duration * 60000);
    if (end <= start) throw new Error('Event end must be after start.');
    if (Utilities.formatDate(start, cfg.timeZone, 'yyyy-MM-dd') < cfg.from) return null;
    body.start = { dateTime: start.toISOString(), timeZone: zone };
    body.end = { dateTime: end.toISOString(), timeZone: zone };
    body.transparency = 'opaque';
    body.reminders = { useDefault: true };
  }
  return body;
}

function eventMatches_(current, desired) {
  function point(value) {
    return value.date || (value.dateTime ? new Date(value.dateTime).toISOString() : '');
  }
  const reminders = current.reminders || {};
  return current.summary === desired.summary && current.description === desired.description &&
    point(current.start || {}) === point(desired.start) && point(current.end || {}) === point(desired.end) &&
    (current.transparency || 'opaque') === desired.transparency &&
    reminders.useDefault === desired.reminders.useDefault &&
    (desired.reminders.useDefault || !(reminders.overrides || []).length);
}

function inRange_(event, cfg) {
  const start = event.start || {};
  return start.date ? start.date >= cfg.from : !!start.dateTime &&
    Utilities.formatDate(new Date(start.dateTime), cfg.timeZone, 'yyyy-MM-dd') >= cfg.from;
}

function buildPlan_(cfg, pages, events) {
  const existing = {};
  events.forEach(function(event) {
    const id = ((event.extendedProperties || {}).private || {}).notionPage;
    if (!id) throw new Error('Owned event lacks its source tag; no writes performed.');
    if (existing[id]) throw new Error('Duplicate owned events found; resolve duplicates before syncing.');
    existing[id] = event;
  });
  const seen = new Set();
  const operations = [];
  const report = { preview: cfg.dryRun, created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0, deferred: 0 };
  pages.forEach(function(page) {
    const id = normalizeId_(page.id);
    if (seen.has(id)) throw new Error('Duplicate Notion page in snapshot; no writes performed.');
    seen.add(id);
    if (page.in_trash || page.archived) { seen.delete(id); return; }
    let body;
    try { body = desiredEvent_(page, cfg); }
    catch (error) { report.skipped++; return; }
    if (!body) { report.skipped++; return; }
    if (existing[id] && eventMatches_(existing[id], body)) report.unchanged++;
    else operations.push({ kind: existing[id] ? 'update' : 'create', pageId: id,
      event: existing[id] || null, body: body });
  });
  // Missing rows can mean a permission change. Require an accessible trashed page.
  if (cfg.deleteArchived) Object.keys(existing).forEach(function(id) {
    if (seen.has(id) || !inRange_(existing[id], cfg)) return;
    let page;
    try { page = notion_(cfg, 'pages/' + normalizeId_(id)); }
    catch (error) { report.skipped++; return; }
    if (page && page.object === 'page' && normalizeId_(page.id) === id && (page.in_trash || page.archived)) {
      operations.push({ kind: 'delete', pageId: id, event: existing[id] });
    } else report.skipped++;
  });
  return { operations: operations, report: report };
}

function owned_(event, cfg, pageId) {
  const tags = (event.extendedProperties || {}).private || {};
  if (tags.syncOwner !== cfg.owner || tags.notionPage !== pageId || event.recurringEventId || event.recurrence) {
    throw new Error('Event ownership or recurrence mismatch; no modification made.');
  }
}

function getEvent_(cfg, id) {
  try { return Calendar.Events.get(cfg.calendarId, id); }
  catch (error) {
    if (/\b404\b|not found/i.test(String(error.message || error))) return null;
    if (/\b410\b|has been deleted/i.test(String(error.message || error))) return { id: id, status: 'cancelled' };
    throw new Error('Calendar event lookup failed.');
  }
}

function applyOperation_(cfg, op) {
  if (op.kind === 'create') {
    const props = PropertiesService.getScriptProperties();
    const key = 'NS_ID_' + cfg.owner + '_' + op.pageId;
    let id = props.getProperty(key) || 'ngs' + digest_(cfg.owner + '|' + op.pageId).slice(0, 40);
    let current = getEvent_(cfg, id);
    if (current && current.status === 'cancelled') {
      id = 'ngs' + Utilities.getUuid().replace(/-/g, '').toLowerCase();
      props.setProperty(key, id); // Reserve before insertion to survive an ambiguous response.
      current = null;
    }
    if (current) { owned_(current, cfg, op.pageId); return; }
    try {
      Calendar.Events.insert(Object.assign({ id: id }, op.body), cfg.calendarId, { sendUpdates: 'none' });
    } catch (error) {
      // A successful insertion may have lost its response; never insert a fresh ID.
      const recovered = getEvent_(cfg, id);
      if (!recovered || recovered.status === 'cancelled') throw error;
      owned_(recovered, cfg, op.pageId);
    }
    return;
  }
  const current = getEvent_(cfg, op.event.id);
  if (!current || current.status === 'cancelled') return;
  owned_(current, cfg, op.pageId);
  if (op.kind === 'delete') {
    if (!inRange_(current, cfg)) return;
    Calendar.Events.remove(cfg.calendarId, current.id, { sendUpdates: 'none' });
  } else {
    const body = Object.assign({}, op.body, {
      start: Object.assign({ date: null, dateTime: null, timeZone: null }, op.body.start),
      end: Object.assign({ date: null, dateTime: null, timeZone: null }, op.body.end),
    });
    Calendar.Events.patch(body, cfg.calendarId, current.id, { sendUpdates: 'none' });
  }
}

function executePlan_(cfg, plan) {
  let attempts = 0;
  for (let index = 0; index < plan.operations.length; index++) {
    const op = plan.operations[index];
    if (cfg.dryRun) {
      plan.report[{ create: 'created', update: 'updated', delete: 'deleted' }[op.kind]]++;
      continue;
    }
    let done = false;
    for (let retry = 0; retry < 4 && attempts < cfg.maxWrites && Date.now() < cfg.deadline; retry++) {
      if (attempts && cfg.gap) pause_(cfg, cfg.gap);
      attempts++;
      try { applyOperation_(cfg, op); done = true; break; }
      catch (error) {
        if (!/429|rate|quota|too many|timeout|timed out|5\d\d|backend|internal/i.test(String(error.message || error))) {
          throw new Error('Calendar write failed; no private error details logged.');
        }
        if (retry < 3 && attempts < cfg.maxWrites) pause_(cfg, Math.pow(2, retry) * 2000);
      }
    }
    if (!done) { plan.report.deferred = plan.operations.length - index; break; }
    plan.report[{ create: 'created', update: 'updated', delete: 'deleted' }[op.kind]]++;
  }
  return plan.report;
}

function runSync_(forcePreview) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Another synchronization is running.');
  try {
    const cfg = loadConfig_();
    if (forcePreview) cfg.dryRun = true;
    resolveSource_(cfg);
    let calendar;
    try { calendar = Calendar.Calendars.get(cfg.calendarId); }
    catch (error) { throw new Error('Cannot access the configured Calendar. Enable the advanced Calendar service and check its ID.'); }
    cfg.timeZone = cfg.timeZone || calendar.timeZone || 'UTC';
    // Validate the zone through Apps Script rather than a platform-specific list.
    Utilities.formatDate(new Date(), cfg.timeZone, 'yyyy-MM-dd');
    cfg.owner = 'nsgc1' + digest_(cfg.calendarId + '|' + cfg.sourceId).slice(0, 24);
    const pages = readPages_(cfg);
    const events = readEvents_(cfg);
    const plan = buildPlan_(cfg, pages, events);
    const report = executePlan_(cfg, plan);
    Logger.log(JSON.stringify(report));
    return report;
  } finally { lock.releaseLock(); }
}

function installSyncTrigger() {
  const cfg = loadConfig_();
  if (cfg.dryRun) throw new Error('Run previewSync, then explicitly set DRY_RUN=false before installing automation.');
  ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'syncNotionToGoogle';
  }).forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('syncNotionToGoogle').timeBased().everyMinutes(10).create();
  Logger.log('A 10-minute synchronization trigger was installed.');
}

function removeSyncTriggers() {
  ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'syncNotionToGoogle';
  }).forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  Logger.log('Synchronization triggers were removed; Calendar events were preserved.');
}
