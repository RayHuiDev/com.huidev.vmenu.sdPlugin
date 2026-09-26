const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOCAL_PORT = 28197;
const DEFAULTS = { action: 'spawn_saved_vehicle' };
const ACTION_BY_UUID = {
  'com.huidev.vmenu.spawn-saved-vehicle': 'spawn_saved_vehicle',
  'com.huidev.vmenu.spawn-saved-ped': 'spawn_saved_ped',
  'com.huidev.vmenu.spawn-saved-mp-ped': 'spawn_saved_mp_ped',
  'com.huidev.vmenu.vehicle-extra': 'vehicle_extra',
  'com.huidev.vmenu.teleport-option': 'teleport_option',
  // Retain support for keys created with the original plugin UUIDs.
  'com.hui.vmenu.spawn_saved_vehicle': 'spawn_saved_vehicle',
  'com.hui.vmenu.spawn_saved_ped': 'spawn_saved_ped',
  'com.hui.vmenu.spawn_saved_mp_ped': 'spawn_saved_mp_ped',
  'com.hui.vmenu.vehicle_extra': 'vehicle_extra',
  'com.hui.vmenu.teleport_option': 'teleport_option'
};
const POLL_TIMEOUT_MS = 25000;
const MAX_QUEUE = 50;
const BOOT_TS = Date.now();

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sdPort = arg('-port');
const pluginUUID = arg('-pluginUUID');
const registerEvent = arg('-registerEvent');

let sd = null;
const contexts = new Map();
const pendingSaves = new Map();
let lastGame = null;
let savedVehicles = [];
let savedPeds = [];
let savedMpPeds = [];
let vehicleExtras = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Extra ${i + 1}` }));
let teleports = [];
let lastQueuedAction = null;
let gameOnlineUntil = 0;
let waiters = [];
const queue = [];

process.on('uncaughtException', (err) => console.error('[vMenuSD] uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('[vMenuSD] unhandledRejection', err));

function isGameOnline() { return Date.now() < gameOnlineUntil; }
function send(obj) {
  try {
    if (sd && sd.readyState === WebSocket.OPEN) sd.send(JSON.stringify(obj));
  } catch (e) { console.error('[vMenuSD] send failed', e); }
}
function setTitle(context, title) { send({ event: 'setTitle', context, payload: { title: String(title), target: 0 } }); }
function showOk(context) { send({ event: 'showOk', context }); }
function showAlert(context) { send({ event: 'showAlert', context }); }

function actionLabel(a) { return String(a || '').replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()); }
function getActionForContext(context, settings) {
  const entry = contexts.get(context) || {};
  const fixed = ACTION_BY_UUID[entry.actionUUID];
  // Older property inspectors saved hyphenated action names. FiveM uses underscores.
  return String(fixed || (settings && settings.action) || entry.settings?.action || DEFAULTS.action).replace(/-/g, '_');
}

function updateTitles() {
  for (const [context, entry] of contexts) {
    const action = getActionForContext(context, entry.settings || {});
    setTitle(context, isGameOnline() ? actionLabel(action) : `Waiting\nFiveM\n${actionLabel(action)}`);
  }
}

function enqueueAction(payload) {
  lastQueuedAction = { ...payload, ts: Date.now(), iso: new Date().toISOString() };
  queue.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ...payload });
  while (queue.length > MAX_QUEUE) queue.shift();
  flushWaiters();
}
function flushWaiters() {
  while (waiters.length && queue.length) {
    const { res, timer } = waiters.shift();
    clearTimeout(timer);
    sendJson(res, 200, { ok: true, action: queue.shift() });
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Connection': 'close',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}
function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Connection': 'close', 'Cache-Control': 'no-store' });
  res.end(text);
}
function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Connection': 'close', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(html);
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}


function getKvsDir() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'CitizenFX', 'kvs');
}

function findJsonPayload(text, startIndex) {
  const firstObj = text.indexOf('{', startIndex);
  const firstArr = text.indexOf('[', startIndex);
  let i = -1;
  if (firstObj >= 0 && firstArr >= 0) i = Math.min(firstObj, firstArr);
  else i = Math.max(firstObj, firstArr);
  if (i < 0) return null;
  const open = text[i];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inString = false, escaped = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

function extractKeyName(text, keyStart, prefix = 'res:vMenu:veh_') {
  let i = keyStart + prefix.length;
  let out = '';
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c < 32 || c > 126) break;
    out += text[i++];
  }
  return out.trim();
}

function normalizeSavedVehicle(key, parsed, file) {
  const data = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!data || typeof data !== 'object') return null;
  const model = data.model ?? data.modelName ?? data.spawnName ?? data.vehicle;
  const hash = data.modelHash ?? data.vehicleHash ?? data.hash;
  const saveName = key.replace(/^res:vMenu:veh_/, '');
  const displayName = data.savedName || data.vehicleName || data.label || data.displayName || saveName || data.name;
  return {
    id: key,
    key,
    name: String(displayName || key),
    model: typeof model === 'object' ? (model.model || model.modelName || model.spawnName) : model,
    hash,
    category: data.Category || data.category || 'Uncategorized',
    file,
    raw: data
  };
}


function normalizeSavedPed(prefixName, key, parsed, file) {
  const data = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!data || typeof data !== 'object') return null;
  const saveName = key.replace(/^res:vMenu:/, '').replace(new RegExp('^' + prefixName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '');
  const displayName = data.SaveName || data.saveName || data.name || data.Name || data.ModelName || data.modelName || saveName;
  const model = data.ModelName || data.modelName || data.model || data.Model || data.PedModel || data.pedModel;
  return { id: key, key, name: String(displayName || saveName || key), model, file, raw: data };
}

function getVarint(buf, pos, limit) {
  let result = 0;
  let shift = 0;
  while (pos < limit && shift <= 28) {
    const c = buf[pos++];
    result |= (c & 0x7f) << shift;
    if (c < 128) return [result >>> 0, pos];
    shift += 7;
  }
  let big = BigInt(result >>> 0);
  let bshift = BigInt(shift);
  while (pos < limit && bshift <= 63n) {
    const c = BigInt(buf[pos++]);
    big |= (c & 0x7fn) << bshift;
    if (c < 128n) return [Number(big), pos];
    bshift += 7n;
  }
  throw new Error('bad varint');
}

function decodeBlockHandle(buf, pos, limit) {
  const a = getVarint(buf, pos, limit);
  const b = getVarint(buf, a[1], limit);
  return { offset: a[0], size: b[0], next: b[1] };
}

function parseLevelDbBlock(block) {
  const entries = [];
  if (!Buffer.isBuffer(block) || block.length < 4) return entries;
  const restartCount = block.readUInt32LE(block.length - 4);
  const restartsOffset = block.length - 4 - restartCount * 4;
  if (restartCount < 1 || restartCount > 100000 || restartsOffset < 0) return entries;
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < restartsOffset) {
    let shared, nonShared, valueLen;
    try {
      [shared, pos] = getVarint(block, pos, restartsOffset);
      [nonShared, pos] = getVarint(block, pos, restartsOffset);
      [valueLen, pos] = getVarint(block, pos, restartsOffset);
    } catch (_) { break; }
    if (shared > key.length || nonShared < 0 || valueLen < 0 || pos + nonShared + valueLen > restartsOffset) break;
    key = Buffer.concat([key.slice(0, shared), block.slice(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.slice(pos, pos + valueLen);
    pos += valueLen;
    entries.push({ key, value });
  }
  return entries;
}

function getInternalKeyInfo(keyBuf) {
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length < 9) return null;
  const userKey = keyBuf.slice(0, keyBuf.length - 8);
  const tag = keyBuf.readBigUInt64LE(keyBuf.length - 8);
  const type = Number(tag & 0xffn);
  const sequence = Number(tag >> 8n);
  return { userKey, type, sequence };
}

function decodeVMenuKvpValue(value) {
  if (!Buffer.isBuffer(value)) value = Buffer.from(value || '');
  let start = -1;
  if (value[0] === 0xd9 && value.length >= 2) start = 2;
  else if (value[0] === 0xda && value.length >= 3) start = 3;
  else if (value[0] === 0xdb && value.length >= 5) start = 5;
  if (start >= 0 && start < value.length && (value[start] === 0x7b || value[start] === 0x5b)) {
    return value.slice(start).toString('utf8');
  }
  const brace = value.indexOf(0x7b);
  const bracket = value.indexOf(0x5b);
  let i = -1;
  if (brace >= 0 && bracket >= 0) i = Math.min(brace, bracket);
  else i = Math.max(brace, bracket);
  return i >= 0 ? value.slice(i).toString('utf8') : value.toString('utf8');
}

function parseLevelDbTableFile(filePath) {
  const found = [];
  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return found; }
  if (buf.length < 48) return found;
  const magic = buf.readBigUInt64LE(buf.length - 8);
  if (magic !== 0xdb4775248b80fb57n) return found;
  const footer = buf.slice(buf.length - 48);
  let indexHandle;
  try {
    let pos = 0;
    const meta = decodeBlockHandle(footer, pos, 40);
    pos = meta.next;
    indexHandle = decodeBlockHandle(footer, pos, 40);
  } catch (_) { return found; }
  const indexBlock = buf.slice(indexHandle.offset, indexHandle.offset + indexHandle.size);
  const indexEntries = parseLevelDbBlock(indexBlock);
  for (const idxEntry of indexEntries) {
    let h;
    try { h = decodeBlockHandle(idxEntry.value, 0, idxEntry.value.length); } catch (_) { continue; }
    if (h.offset < 0 || h.size < 0 || h.offset + h.size + 5 > buf.length) continue;
    const compression = buf[h.offset + h.size];
    if (compression !== 0) continue;
    const entries = parseLevelDbBlock(buf.slice(h.offset, h.offset + h.size));
    for (const entry of entries) {
      const info = getInternalKeyInfo(entry.key);
      if (!info || info.type !== 1) continue;
      const userKey = info.userKey.toString('utf8');
      if (!/^res:vMenu:(veh_|ped_|mp_ped_)/.test(userKey)) continue;
      found.push({ key: userKey, value: entry.value, sequence: info.sequence });
    }
  }
  return found;
}


function readSavedItemsFromDisk(kind) {
  const kvsDir = getKvsDir();
  const byKey = new Map();
  let files = [];
  try { files = fs.readdirSync(kvsDir).filter(f => /\.(ldb|sst|log)$/i.test(f)); }
  catch (e) { return { ok: false, kvsDir, error: `Could not read KVS folder: ${e.message}`, items: [] }; }

  const prefixMap = {
    vehicles: 'res:vMenu:veh_',
    peds: 'res:vMenu:ped_',
    mpPeds: 'res:vMenu:mp_ped_'
  };
  const prefix = prefixMap[kind];
  for (const file of files.filter(f => /\.(ldb|sst)$/i.test(f))) {
    for (const rec of parseLevelDbTableFile(path.join(kvsDir, file))) {
      if (!rec.key.startsWith(prefix)) continue;
      try {
        const jsonText = decodeVMenuKvpValue(rec.value);
        const parsed = JSON.parse(jsonText);
        let item;
        if (kind === 'vehicles') item = normalizeSavedVehicle(rec.key, parsed, file);
        else item = normalizeSavedPed(kind === 'peds' ? 'ped_' : 'mp_ped_', rec.key, parsed, file);
        if (!item) continue;
        const old = byKey.get(item.key);
        if (!old || rec.sequence >= old.sequence) byKey.set(item.key, { ...item, sequence: rec.sequence });
      } catch (_) {}
    }
  }
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(kvsDir, file)).toString('latin1'); } catch { continue; }
    let idx = 0;
    while ((idx = text.indexOf(prefix, idx)) >= 0) {
      const name = extractKeyName(text, idx, prefix);
      const key = `${prefix}${name}`;
      const jsonText = findJsonPayload(text, idx + key.length);
      idx += prefix.length;
      if (!name || !jsonText || byKey.has(key)) continue;
      try {
        const parsed = JSON.parse(jsonText);
        let item;
        if (kind === 'vehicles') item = normalizeSavedVehicle(key, parsed, file);
        else item = normalizeSavedPed(kind === 'peds' ? 'ped_' : 'mp_ped_', key, parsed, file);
        if (item) byKey.set(item.key, { ...item, sequence: 0 });
      } catch (_) {}
    }
  }
  const items = Array.from(byKey.values()).map(({ sequence, ...v }) => v);
  items.sort((a,b) => String(a.name).localeCompare(String(b.name)));
  return { ok: true, kvsDir, filesScanned: files.length, items };
}

function readSavedVehiclesFromDisk() {
  const r = readSavedItemsFromDisk('vehicles');
  return { ...r, vehicles: r.items || [] };
}

function refreshSavedVehiclesFromDisk() { const result = readSavedVehiclesFromDisk(); savedVehicles = result.vehicles || []; return result; }
function refreshSavedPedsFromDisk() { const result = readSavedItemsFromDisk('peds'); savedPeds = result.items || []; return { ...result, peds: savedPeds }; }
function refreshSavedMpPedsFromDisk() { const result = readSavedItemsFromDisk('mpPeds'); savedMpPeds = result.items || []; return { ...result, mpPeds: savedMpPeds }; }

function statusPayload() {
  return {
    ok: true,
    bridge: 'vMenu Stream Deck',
    version: '0.15.0',
    port: LOCAL_PORT,
    uptimeSeconds: Math.round((Date.now() - BOOT_TS) / 1000),
    streamDeckSocket: sd ? ['CONNECTING','OPEN','CLOSING','CLOSED'][sd.readyState] : 'not_started',
    gameOnline: isGameOnline(),
    queue: queue.length,
    waitingPolls: waiters.length,
    contexts: Array.from(contexts.entries()).map(([context, entry]) => ({ context, actionUUID: entry.actionUUID, settings: entry.settings, resolvedAction: getActionForContext(context, entry.settings || {}) })),
    lastQueuedAction,
    lastGame,
    savedVehicles, savedPeds, savedMpPeds, vehicleExtras, teleports,
    savedVehicleSource: getKvsDir()
  };
}

function startLocalHttpBridge() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
      const url = new URL(req.url || '/', `http://127.0.0.1:${LOCAL_PORT}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
        return sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><title>vMenu Stream Deck</title><pre>${JSON.stringify(statusPayload(), null, 2)}</pre>`);
      }
      if (req.method === 'GET' && url.pathname === '/status') return sendJson(res, 200, statusPayload());
      if (req.method === 'GET' && url.pathname === '/ping') return sendText(res, 200, 'pong');
      if (req.method === 'GET' && url.pathname === '/saved-vehicles') { const result = refreshSavedVehiclesFromDisk();
refreshSavedPedsFromDisk();
refreshSavedMpPedsFromDisk(); return sendJson(res, 200, { ...result, count: savedVehicles.length }); }
      if (req.method === 'GET' && url.pathname === '/saved-peds') { const result = refreshSavedPedsFromDisk(); return sendJson(res, 200, { ...result, count: savedPeds.length }); }
      if (req.method === 'GET' && url.pathname === '/saved-mp-peds') { const result = refreshSavedMpPedsFromDisk(); return sendJson(res, 200, { ...result, count: savedMpPeds.length }); }
      if (req.method === 'GET' && url.pathname === '/vehicle-extras') return sendJson(res, 200, { ok: true, vehicleExtras, count: vehicleExtras.length });
      if (req.method === 'GET' && url.pathname === '/teleports') return sendJson(res, 200, { ok: true, teleports, count: teleports.length });

      if (req.method === 'POST' && url.pathname === '/register') {
        const body = await readBody(req);
        lastGame = { ...body, ts: Date.now(), iso: new Date().toISOString() };
        if (Array.isArray(body.savedVehicles) && body.savedVehicles.length) savedVehicles = body.savedVehicles;
        // Keep vehicle extras static (1-12). Do not overwrite with the current vehicle's extras.
        if (Array.isArray(body.teleports)) teleports = body.teleports;
        gameOnlineUntil = Date.now() + 15000;
        updateTitles();
        return sendJson(res, 200, { ok: true, registered: true, port: LOCAL_PORT });
      }

      if (req.method === 'GET' && url.pathname === '/poll') {
        gameOnlineUntil = Date.now() + 15000;
        updateTitles();
        if (queue.length) return sendJson(res, 200, { ok: true, action: queue.shift() });
        const timer = setTimeout(() => {
          waiters = waiters.filter(w => w.res !== res);
          sendJson(res, 200, { ok: true, action: null });
        }, POLL_TIMEOUT_MS);
        req.on('close', () => {
          waiters = waiters.filter(w => w.res !== res);
          clearTimeout(timer);
        });
        waiters.push({ res, timer });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/ack') {
        const body = await readBody(req);
        console.log('[vMenuSD] ACK', body);
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { ok: false, error: 'not_found', path: url.pathname });
    } catch (err) {
      console.error('[vMenuSD] HTTP handler error', err);
      try { return sendJson(res, 500, { ok: false, error: 'handler_exception', message: String(err && err.message || err) }); } catch (_) {}
    }
  });

  server.on('clientError', (err, socket) => {
    console.error('[vMenuSD] clientError', err.message);
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (_) {}
  });
  server.on('error', err => console.error('[vMenuSD] HTTP bridge error:', err));
  server.listen(LOCAL_PORT, '127.0.0.1', () => console.log(`[vMenuSD] Local bridge listening on http://127.0.0.1:${LOCAL_PORT}`));
}

async function runAction(context, settings) {
  const action = getActionForContext(context, settings || {});
  let args = (settings && settings.args) || contexts.get(context)?.settings?.args || {};
  if (action === 'spawn_saved_vehicle') {
    const savedVehicleId = settings?.savedVehicleId || contexts.get(context)?.settings?.savedVehicleId || '';
    if (!savedVehicles.length) refreshSavedVehiclesFromDisk();
refreshSavedPedsFromDisk();
refreshSavedMpPedsFromDisk();
    const savedVehicle = savedVehicles.find(v => v.id === savedVehicleId || v.key === savedVehicleId) || null;
    args = { ...args, savedVehicleId, savedVehicleData: savedVehicle ? savedVehicle.raw : null, savedVehicleName: savedVehicle ? savedVehicle.name : '' };
  } else if (action === 'spawn_saved_ped') {
    const savedPedId = settings?.savedPedId || contexts.get(context)?.settings?.savedPedId || '';
    if (!savedPeds.length) refreshSavedPedsFromDisk();
    const savedPed = savedPeds.find(v => v.id === savedPedId || v.key === savedPedId) || null;
    args = { ...args, savedPedId, savedPedData: savedPed ? savedPed.raw : null, savedPedName: savedPed ? savedPed.name : '' };
  } else if (action === 'spawn_saved_mp_ped') {
    const savedMpPedId = settings?.savedMpPedId || contexts.get(context)?.settings?.savedMpPedId || '';
    if (!savedMpPeds.length) refreshSavedMpPedsFromDisk();
    const savedMpPed = savedMpPeds.find(v => v.id === savedMpPedId || v.key === savedMpPedId) || null;
    args = { ...args, savedMpPedId, savedMpPedData: savedMpPed ? savedMpPed.raw : null, savedMpPedName: savedMpPed ? savedMpPed.name : '' };
  } else if (action === 'vehicle_extra') {
    args = { ...args, extra: Number(settings?.extra || contexts.get(context)?.settings?.extra || 1), mode: settings?.mode || contexts.get(context)?.settings?.mode || 'toggle' };
  } else if (action === 'teleport_option') {
    args = { ...args, teleportId: settings?.teleportId || contexts.get(context)?.settings?.teleportId || '' };
  }
  if (!isGameOnline()) { showAlert(context); updateTitles(); return; }
  enqueueAction({ type: 'action', action, args });
  console.log('[vMenuSD] queued action', action, 'context', context);
  showOk(context);
  updateTitles();
}

function connectStreamDeck() {
  if (!sdPort || !pluginUUID || !registerEvent) {
    console.error('[vMenuSD] Missing Stream Deck launch args', process.argv);
    return;
  }
  if (typeof WebSocket === 'undefined') {
    console.error('[vMenuSD] No global WebSocket. This needs Stream Deck Node runtime with WebSocket support. HTTP diagnostics still run.');
    return;
  }
  sd = new WebSocket(`ws://127.0.0.1:${sdPort}`);
  sd.addEventListener('open', () => { send({ event: registerEvent, uuid: pluginUUID }); console.log('[vMenuSD] Registered with Stream Deck'); });
  sd.addEventListener('message', async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const context = msg.context;
    if (msg.event === 'willAppear') { contexts.set(context, { actionUUID: msg.action, settings: msg.payload?.settings || {} }); updateTitles(); }
    else if (msg.event === 'willDisappear') { contexts.delete(context); pendingSaves.delete(context); }
    else if (msg.event === 'didReceiveSettings') {
      const old = contexts.get(context) || {};
      const settings = msg.payload?.settings || {};
      let pending = pendingSaves.get(context);
      if (pending && Date.now() > pending.expiresAt) {
        pendingSaves.delete(context);
        pending = null;
      }
      const confirmed = pending && Object.entries(pending.settings).every(([key, value]) => JSON.stringify(settings[key]) === JSON.stringify(value));
      // A getSettings response sent before Save can arrive after the save request.
      if (pending && !confirmed) return;
      contexts.set(context, { ...old, actionUUID: msg.action || old.actionUUID, settings });
      if (confirmed) {
        pendingSaves.delete(context);
        send({ event: 'sendToPropertyInspector', action: msg.action || old.actionUUID, context, payload: { event: 'settingsSaved', requestId: pending.requestId, settings } });
      }
      updateTitles();
    }
    else if (msg.event === 'sendToPlugin' && msg.payload && msg.payload.settings) {
      const target = msg.payload.context || msg.context;
      const old = contexts.get(target) || contexts.get(context) || {};
      const merged = { ...(old.settings || {}), ...msg.payload.settings };
      contexts.set(target, { ...old, actionUUID: msg.action || old.actionUUID, settings: merged });
      if (msg.payload.requestId) pendingSaves.set(target, { requestId: msg.payload.requestId, settings: merged, expiresAt: Date.now() + 5000 });
      send({ event: 'setSettings', context: target, payload: merged });
      if (msg.payload.requestId) send({ event: 'getSettings', context: target });
      updateTitles();
    }
    else if (msg.event === 'keyDown') { const old = contexts.get(context) || { actionUUID: msg.action, settings: {} }; contexts.set(context, { ...old, actionUUID: msg.action }); await runAction(context, msg.payload?.settings || old.settings || DEFAULTS); }
  });
  sd.addEventListener('error', (e) => console.error('[vMenuSD] Stream Deck websocket error', e));
}

refreshSavedVehiclesFromDisk();
refreshSavedPedsFromDisk();
refreshSavedMpPedsFromDisk();
setInterval(updateTitles, 5000);
startLocalHttpBridge();
connectStreamDeck();
