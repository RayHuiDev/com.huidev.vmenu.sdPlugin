const config = document.body.dataset;
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');
const itemEl = document.getElementById('item');
const extraEl = document.getElementById('extra');
const modeEl = document.getElementById('mode');
const refreshBtn = document.getElementById('refresh');
let websocket = null;
let piUuid = null;
let actionInfo = {};
let settings = {};
let items = [];
let loading = false;
let pendingSave = null;
let saveTimer = null;
let requestSequence = 0;

const itemId = item => String(item.id ?? item.key ?? item.name ?? '');
const itemName = item => String(item.name || item.model || itemId(item));
const connected = () => websocket && websocket.readyState === WebSocket.OPEN;
const selectedItem = () => items.find(item => itemId(item) === itemEl?.value);

function updateSaveButton() {
  saveBtn.disabled = !connected() || loading || (!extraEl && !selectedItem());
}

function send(event, payload) {
  if (!connected()) return false;
  websocket.send(JSON.stringify({ event, action: actionInfo.action, context: piUuid, ...(payload === undefined ? {} : { payload }) }));
  return true;
}

function applySettings() {
  if (extraEl) {
    extraEl.value = String(settings.extra || 1);
    modeEl.value = settings.mode || 'toggle';
  } else if (settings[config.idSetting] && items.some(item => itemId(item) === String(settings[config.idSetting]))) {
    itemEl.value = String(settings[config.idSetting]);
  }
  updateSaveButton();
}

function save() {
  if (!connected()) {
    statusEl.textContent = 'Stream Deck is disconnected. Reopen this key\'s settings.';
    return;
  }
  if (loading) return;
  let selection;
  if (extraEl) {
    selection = { extra: Number(extraEl.value), mode: modeEl.value };
  } else {
    const item = selectedItem();
    if (!item) {
      statusEl.textContent = 'Choose an available item before saving.';
      return;
    }
    selection = { [config.idSetting]: itemId(item), [config.nameSetting]: itemName(item) };
  }
  settings = { ...settings, ...selection, action: config.action };
  clearTimeout(saveTimer);
  const requestId = `${piUuid}-${++requestSequence}`;
  pendingSave = requestId;
  statusEl.textContent = 'Saving...';
  send('sendToPlugin', { settings, context: actionInfo.context || piUuid, requestId });
  saveTimer = setTimeout(() => {
    if (pendingSave !== requestId) return;
    pendingSave = null;
    statusEl.textContent = 'Save was not confirmed. Click Save to try again.';
  }, 5000);
}

async function loadItems() {
  if (loading) return;
  loading = true;
  updateSaveButton();
  statusEl.textContent = 'Refreshing...';
  try {
    const response = await fetch('http://127.0.0.1:28197' + config.endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error('Bridge request failed');
    const data = await response.json();
    if (data.ok === false) throw new Error('List unavailable');
    const list = data[config.listKey] || data.items;
    if (!Array.isArray(list)) throw new Error('Invalid list');
    const previous = String(settings[config.idSetting] || itemEl.value || '');
    items = list;
    itemEl.replaceChildren();
    for (const item of items) {
      const option = document.createElement('option');
      option.value = itemId(item);
      option.textContent = itemName(item);
      itemEl.appendChild(option);
    }
    if (previous && !items.some(item => itemId(item) === previous)) {
      const option = document.createElement('option');
      option.value = previous;
      option.textContent = (settings[config.nameSetting] || 'Saved selection') + ' (unavailable)';
      option.disabled = true;
      itemEl.appendChild(option);
      itemEl.value = previous;
      statusEl.textContent = 'Saved selection not found. Refresh or choose another item.';
    } else if (!items.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'None found';
      itemEl.appendChild(option);
      statusEl.textContent = 'No items found. Save one in vMenu, then refresh.';
    } else {
      if (previous) itemEl.value = previous;
      statusEl.textContent = 'Choose an item, then click Save.';
    }
  } catch (_) {
    statusEl.textContent = 'Could not refresh the list. Your saved selection is unchanged.';
  } finally {
    loading = false;
    updateSaveButton();
  }
}

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  piUuid = inUUID;
  try { actionInfo = JSON.parse(inActionInfo || '{}'); } catch (_) { actionInfo = {}; }
  settings = { ...(actionInfo.payload?.settings || {}) };
  applySettings();
  websocket = new WebSocket('ws://127.0.0.1:' + inPort);
  websocket.onopen = () => {
    websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: piUuid }));
    send('getSettings');
    if (itemEl) loadItems();
    else {
      updateSaveButton();
      statusEl.textContent = 'Choose an extra and mode, then click Save.';
    }
  };
  websocket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.event === 'didReceiveSettings' && !pendingSave) {
      settings = { ...settings, ...(message.payload?.settings || {}) };
      applySettings();
    } else if (message.event === 'sendToPropertyInspector' && message.payload?.event === 'settingsSaved' && message.payload.requestId === pendingSave) {
      clearTimeout(saveTimer);
      pendingSave = null;
      settings = { ...settings, ...message.payload.settings };
      applySettings();
      statusEl.textContent = 'Saved.';
    }
  };
  websocket.onclose = () => {
    clearTimeout(saveTimer);
    pendingSave = null;
    updateSaveButton();
    statusEl.textContent = 'Stream Deck is disconnected. Reopen this key\'s settings.';
  };
}

if (extraEl) {
  for (let id = 1; id <= 12; id++) {
    const option = document.createElement('option');
    option.value = String(id);
    option.textContent = `Extra ${id}`;
    extraEl.appendChild(option);
  }
  extraEl.addEventListener('change', save);
  modeEl.addEventListener('change', save);
} else {
  itemEl.addEventListener('change', save);
  refreshBtn.addEventListener('click', loadItems);
}
saveBtn.addEventListener('click', save);
