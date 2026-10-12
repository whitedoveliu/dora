/* Dora.ai management console — plain ES module, no dependencies.
 *
 * One API surface (see README.md). Every server string reaches the DOM through
 * textContent: there is no innerHTML in this file.
 */

/* ---------------------------------------------------------------- token -- */

var TOKEN_KEY = 'dora.token';
var token = '';

function storedToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (err) { return ''; }
}

/** The token query parameter wins, then it is persisted and stripped from the URL. */
function readTokenFromQuery() {
  try {
    var url = new URL(window.location.href);
    var value = url.searchParams.get('token');
    if (!value) return '';
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return value;
  } catch (err) {
    return '';
  }
}

function storeToken(value) {
  token = value || '';
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (err) { /* private mode: the token lives for this page only */ }
}

/** EventSource cannot set headers, so the SSE endpoints take the token in the URL. */
function withToken(url) {
  if (!token) return url;
  return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
}

/* ------------------------------------------------------------ dom utils -- */

function append(node, children) {
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) { append(node, child); continue; }
    if (child instanceof Node) { node.appendChild(child); continue; }
    node.appendChild(document.createTextNode(String(child)));
  }
}

/** Element builder. Only safe properties are honoured; raw HTML is never accepted. */
function h(tag, props) {
  var node = document.createElement(tag);
  if (props) {
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      var value = props[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') { for (var d in value) node.dataset[d] = String(value[d]); }
      else if (key === 'value') node.value = String(value);
      else if (key === 'checked') node.checked = !!value;
      else if (key === 'disabled') node.disabled = !!value;
      else if (key === 'hidden') node.hidden = !!value;
      else if (key === 'selected') node.selected = !!value;
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, Array.prototype.slice.call(arguments, 2));
  return node;
}

function clear(node) { node.replaceChildren(); }

function text(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/* --------------------------------------------------------------- banner -- */

var bannerEl = null;
var bannerTextEl = null;

function showBanner(message, kind) {
  if (!bannerEl) return;
  bannerEl.hidden = false;
  bannerEl.dataset.kind = kind || 'error';
  bannerTextEl.textContent = String(message);
}

function hideBanner() {
  if (!bannerEl) return;
  bannerEl.hidden = true;
  bannerTextEl.textContent = '';
}

/* ---------------------------------------------------------------- modal -- */

/** showModal({title, description, fields, submitLabel}) -> Promise<values|null> */
function showModal(options) {
  return new Promise(function (resolve) {
    var overlay = h('div', { class: 'modal-overlay' });
    var dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title });
    var form = h('form', {});
    var inputs = {};
    var fields = options.fields || [];

    form.appendChild(h('h2', {}, options.title));
    if (options.description) form.appendChild(h('p', {}, options.description));

    fields.forEach(function (field) {
      var control;
      if (field.type === 'select') {
        control = h('select', { name: field.name });
        (field.options || []).forEach(function (option) {
          control.appendChild(h('option', { value: option.value, selected: option.value === field.value }, option.label));
        });
      } else if (field.type === 'checkbox') {
        control = h('input', { type: 'checkbox', name: field.name, checked: !!field.value });
      } else {
        control = h('input', {
          type: field.type || 'text',
          name: field.name,
          value: field.value === undefined ? '' : field.value,
          placeholder: field.placeholder || '',
          autocomplete: 'off',
          spellcheck: 'false'
        });
      }
      if (field.required) control.required = true;
      inputs[field.name] = { control: control, field: field };
      form.appendChild(h('label', { class: 'field' }, field.label, control));
    });

    var submit = h('button', { class: 'btn btn-primary', type: 'submit' }, options.submitLabel || 'Save');
    var cancel = h('button', { class: 'btn', type: 'button', onclick: function () { close(null); } }, options.cancelLabel || 'Cancel');
    form.appendChild(h('div', { class: 'modal-actions' }, cancel, submit));

    var closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    }

    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(null); }
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var values = {};
      var missing = null;
      Object.keys(inputs).forEach(function (name) {
        var entry = inputs[name];
        var value = entry.field.type === 'checkbox' ? entry.control.checked : entry.control.value.trim();
        if (entry.field.required && !value) missing = missing || entry.field.label;
        values[name] = value;
      });
      if (missing) { showBanner('Please fill in: ' + missing, 'warn'); return; }
      close(values);
    });

    overlay.addEventListener('mousedown', function (event) { if (event.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);
    overlay.appendChild(dialog);
    dialog.appendChild(form);
    document.body.appendChild(overlay);
    var first = fields.length > 0 ? inputs[fields[0].name].control : submit;
    try { first.focus(); } catch (err) { /* focus is best effort */ }
    if (first.select && fields.length > 0 && fields[0].type !== 'checkbox') { try { first.select(); } catch (err) {} }
  });
}

function promptForToken(message) {
  return showModal({
    title: 'Admin token',
    description: message + ' The token is stored in this browser only, under localStorage key dora.token, and sent as an Authorization: Bearer header.',
    fields: [{ name: 'token', label: 'Token', type: 'password', required: true, placeholder: 'paste the admin token' }],
    submitLabel: 'Save and continue'
  }).then(function (values) {
    if (!values || !values.token) return '';
    storeToken(values.token);
    refreshHealth();
    return values.token;
  });
}

/* ------------------------------------------------------------- api call -- */

function ApiError(message, status) {
  this.name = 'ApiError';
  this.message = String(message);
  this.status = status || 0;
}
ApiError.prototype = Object.create(Error.prototype);
ApiError.prototype.constructor = ApiError;

function describeNetworkError(err) {
  var detail = err && err.message ? err.message : 'network error';
  return 'Cannot reach the API (' + detail + '). Is the Dora server running?';
}

async function api(path, options) {
  options = options || {};
  var attempt = options.attempt || 1;
  var headers = {};
  if (token) headers['authorization'] = 'Bearer ' + token;
  var init = { method: options.method || 'GET', headers: headers, cache: 'no-store' };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  var response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new ApiError(describeNetworkError(err), 0);
  }

  if (response.status === 401 && attempt === 1) {
    var entered = await promptForToken('The API rejected the current admin token.');
    if (entered) {
      var retryOptions = {};
      Object.keys(options).forEach(function (key) { retryOptions[key] = options[key]; });
      retryOptions.attempt = 2;
      return api(path, retryOptions);
    }
    throw new ApiError('Not authorised: no valid admin token was provided.', 401);
  }

  var raw = '';
  try { raw = await response.text(); } catch (err) { raw = ''; }
  var data = null;
  if (raw) { try { data = JSON.parse(raw); } catch (err) { data = null; } }

  if (!response.ok) {
    var message = data && typeof data.error === 'string'
      ? data.error
      : (raw ? raw.slice(0, 400) : response.status + ' ' + response.statusText);
    throw new ApiError(message, response.status);
  }
  return data;
}

/* -------------------------------------------------------------- formats -- */

function fmtTime(ms) {
  if (!ms) return '—';
  var date = new Date(Number(ms));
  if (isNaN(date.getTime())) return String(ms);
  return date.toLocaleString();
}

function fmtAgo(ms) {
  if (!ms) return '—';
  var diff = Date.now() - Number(ms);
  if (isNaN(diff)) return '—';
  if (diff < 0) return 'in ' + fmtDuration(-diff);
  return fmtDuration(diff) + ' ago';
}

function fmtDuration(ms) {
  var seconds = Math.floor(Number(ms || 0) / 1000);
  if (seconds < 60) return seconds + 's';
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
  var days = Math.floor(hours / 24);
  return days + 'd ' + (hours % 24) + 'h';
}

function fmtNumber(value) {
  if (typeof value !== 'number' || !isFinite(value)) return text(value);
  return value.toLocaleString();
}

function fmtPercent(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  return value.toFixed(1) + '%';
}

function jsonText(value) {
  try { return JSON.stringify(value, null, 2); } catch (err) { return String(value); }
}

function bytes(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ---------------------------------------------------------- ui elements -- */

function badge(label, tone) {
  return h('span', { class: 'badge', 'data-tone': tone || 'none' }, label);
}

function section(title, note, children) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', { class: 'section-title' }, title),
      note ? h('span', { class: 'section-note' }, note) : null),
    children);
}

function dataTable(columns, rows) {
  if (!rows || rows.length === 0) return h('p', { class: 'empty' }, 'Nothing to show.');
  var head = h('thead', {}, h('tr', {}, columns.map(function (column) {
    return h('th', { scope: 'col', class: column.align ? 'align-' + column.align : null }, column.label);
  })));
  var body = h('tbody', {}, rows.map(function (row) {
    return h('tr', { dataset: { selected: row.__selected ? 'true' : 'false' } }, columns.map(function (column) {
      var value = column.render ? column.render(row) : row[column.key];
      return h('td', { class: column.align ? 'align-' + column.align : null }, value === undefined || value === null ? '—' : value);
    }));
  }));
  return h('div', { class: 'table-wrap' }, h('table', {}, head, body));
}

function field(labelText, control, hint) {
  return h('label', { class: 'field' }, labelText, control, hint ? h('span', { class: 'small muted' }, hint) : null);
}

function loading(label) {
  return h('p', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
}

function statusBadge(status) {
  var tone = status === 'running' ? 'ok' : status === 'held' ? 'warn' : status === 'failed' ? 'danger' : 'none';
  return badge(text(status), tone);
}

/* ------------------------------------------------------------ flag cache -- */

var flagsCache = null;

async function loadFlags(force) {
  if (!flagsCache || force) {
    var data = await api('/api/flags');
    flagsCache = (data && data.flags) || {};
  }
  return flagsCache;
}

async function loadFlagsSafe() {
  try { return await loadFlags(true); } catch (err) { return flagsCache || {}; }
}

/* -------------------------------------------------------------- routing -- */

var ROUTES = [
  { path: '/overview', label: 'Overview', render: viewOverview },
  { path: '/sessions', label: 'Sessions', render: viewSessions },
  { path: '/connectors', label: 'Connectors', render: viewConnectors },
  { path: '/tools', label: 'Tools', render: viewTools },
  { path: '/skills', label: 'Skills', render: viewSkills },
  { path: '/memory', label: 'Memory', render: viewMemory },
  { path: '/observations', label: 'Observations', render: viewObservations },
  { path: '/vault', label: 'Vault', render: viewVault },
  { path: '/channels', label: 'Channels', render: viewChannels }
];

var disposeCurrent = null;
var currentPath = '/overview';

function parseHash() {
  var raw = window.location.hash.replace(/^#/, '');
  if (!raw) return { path: '/overview', query: new URLSearchParams('') };
  var index = raw.indexOf('?');
  var path = index === -1 ? raw : raw.slice(0, index);
  var search = index === -1 ? '' : raw.slice(index + 1);
  if (path.charAt(0) !== '/') path = '/' + path;
  if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
  return { path: path, query: new URLSearchParams(search) };
}

function buildNav() {
  var nav = document.getElementById('nav');
  ROUTES.forEach(function (route) {
    nav.appendChild(h('a', { href: '#', dataset: { path: route.path }, onclick: function (event) {
      event.preventDefault();
      if (window.location.hash === '#' + route.path) { void routeTo(); return; }
      window.location.hash = '#' + route.path;
    } }, route.label));
  });
}

function setActiveNav(path) {
  var links = document.querySelectorAll('#nav a');
  for (var i = 0; i < links.length; i++) {
    if (links[i].dataset.path === path) links[i].setAttribute('aria-current', 'page');
    else links[i].removeAttribute('aria-current');
  }
}

function renderFailure(view, err) {
  var message = err && err.message ? err.message : String(err);
  view.appendChild(h('div', { class: 'panel' },
    h('h2', { class: 'section-title' }, 'This section could not load'),
    h('p', { class: 'empty' }, message),
    h('div', { class: 'inline' }, h('button', { class: 'btn', type: 'button', onclick: function () { void routeTo(); } }, 'Retry'))));
}

async function routeTo() {
  var parsed = parseHash();
  var match = null;
  for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].path === parsed.path) match = ROUTES[i];
  if (!match) match = ROUTES[0];
  currentPath = match.path;

  if (disposeCurrent) {
    try { disposeCurrent(); } catch (err) { /* a failed dispose must not block the next view */ }
    disposeCurrent = null;
  }

  setActiveNav(match.path);
  var view = document.getElementById('view');
  clear(view);
  view.appendChild(loading('Loading ' + match.label + '…'));
  hideBanner();

  try {
    var dispose = await match.render(view, parsed.query);
    disposeCurrent = typeof dispose === 'function' ? dispose : null;
  } catch (err) {
    clear(view);
    renderFailure(view, err);
    showBanner(err && err.message ? err.message : String(err), 'error');
  }
}

function refresh() { void routeTo(); }

/* ------------------------------------------------------------- header UX -- */

async function refreshHealth() {
  var chip = document.getElementById('health-chip');
  try {
    var health = await api('/api/health');
    chip.dataset.tone = 'ok';
    chip.textContent = 'v' + text(health.version) + ' · up ' + fmtDuration(health.uptime_ms);
    chip.title = 'account ' + text(health.account) + ' · data ' + text(health.data_dir);
  } catch (err) {
    chip.dataset.tone = 'danger';
    chip.textContent = 'API unreachable';
    chip.title = err && err.message ? err.message : '';
  }
}

var globalStream = null;
var globalStreamCount = 0;

function setStreamChip(label, tone, title) {
  var chip = document.getElementById('stream-chip');
  chip.textContent = label;
  chip.dataset.tone = tone;
  chip.title = title || '';
}

function stopGlobalStream() {
  if (globalStream) { globalStream.close(); globalStream = null; }
  setStreamChip('events: off', 'none', 'Stream every runtime event (/api/events/stream)');
}

function toggleGlobalStream() {
  if (globalStream) { stopGlobalStream(); return; }
  globalStreamCount = 0;
  setStreamChip('events: connecting…', 'accent', 'Connecting to /api/events/stream');
  var source = new EventSource(withToken('/api/events/stream'));
  globalStream = source;
  source.addEventListener('hello', function (event) {
    var data = {};
    try { data = JSON.parse(event.data); } catch (err) { data = {}; }
    setStreamChip('events: 0', 'accent', 'Hello from account ' + text(data.account));
  });
  source.addEventListener('event', function (event) {
    globalStreamCount += 1;
    var type = '';
    try { type = JSON.parse(event.data).type || ''; } catch (err) { type = ''; }
    setStreamChip('events: ' + globalStreamCount, 'accent', 'Last event: ' + type);
  });
  source.addEventListener('error', function () {
    if (globalStream !== source) return;
    setStreamChip('events: retrying…', 'danger', 'The event stream dropped; the browser is retrying.');
  });
}

/* -------------------------------------------------------------- overview -- */

function connectorStateBadge(connected) {
  return connected ? badge('connected', 'ok') : badge('not connected', 'none');
}

function accountRowForm(connector, onDone, compact) {
  var label = h('input', { type: 'text', placeholder: 'label (for example: work)', 'aria-label': 'Account label' });
  var needsSecret = connector.authKind !== 'none';
  var secret = h('input', { type: 'password', placeholder: connector.authKind === 'password' ? 'app password (optional)' : 'access token (optional)', 'aria-label': 'Credential' });
  var button = h('button', { class: 'btn btn-primary' + (compact ? ' btn-sm' : ''), type: 'submit' }, 'Connect');

  var form = h('form', { class: 'row' },
    h('span', { class: 'field', style: 'flex:1 1 140px' }, label),
    needsSecret ? h('span', { class: 'field', style: 'flex:1 1 160px' }, secret) : null,
    h('span', { class: 'field', style: 'flex:0 0 auto' }, button));

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var value = label.value.trim();
    if (!value) { showBanner('An account label is required.', 'warn'); label.focus(); return; }
    button.disabled = true;
    button.textContent = 'Connecting…';
    try {
      var body = { connector: connector.name, label: value };
      if (needsSecret && secret.value) body.token = secret.value;
      await api('/api/connectors/accounts', { method: 'POST', body: body });
      showBanner('Connected ' + connector.title + ' as "' + value + '".', 'ok');
      if (onDone) onDone();
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Connect';
    }
  });

  return form;
}

function renderFlagList(host) {
  clear(host);
  host.appendChild(loading('Loading flags…'));
  loadFlags(true).then(function (flags) {
    var names = Object.keys(flags).sort();
    clear(host);
    if (names.length === 0) { host.appendChild(h('p', { class: 'empty' }, 'No flags reported.')); return; }
    host.appendChild(h('div', { class: 'stack' }, names.map(function (name) {
      var box = h('input', { type: 'checkbox', checked: !!flags[name], 'aria-label': 'Flag ' + name });
      box.addEventListener('change', async function () {
        box.disabled = true;
        try {
          var result = await api('/api/flags', { method: 'POST', body: { name: name, enabled: box.checked } });
          flagsCache = (result && result.flags) || flagsCache;
          var now = !!(flagsCache && flagsCache[name]);
          box.checked = now;
          showBanner('Flag ' + name + ' is now ' + (now ? 'on' : 'off') + '.', 'ok');
          if (name === 'agent_chat') refresh();
        } catch (err) {
          box.checked = !box.checked;
          showBanner(err.message, 'error');
        } finally {
          box.disabled = false;
        }
      });
      return h('label', { class: 'check' }, box, h('span', { class: 'mono' }, name));
    })));
  }).catch(function (err) {
    clear(host);
    host.appendChild(h('p', { class: 'empty' }, 'Flags unavailable: ' + err.message));
  });
}

async function viewOverview(view) {
  var data = await api('/api/overview');
  clear(view);

  var account = data.account || {};
  var sources = data.observations || [];
  var connectors = data.connectors || [];
  var leases = data.leases || [];
  var budget = data.budget || {};
  var todos = data.todos || {};
  var eventCount = data.events && typeof data.events.n === 'number' ? data.events.n : 0;
  var observationRows = typeof data.observation_rows === 'number' ? data.observation_rows : sources.reduce(function (sum, s) { return sum + (s.rows || 0); }, 0);

  var tiles = [
    { label: 'Sessions', value: fmtNumber(data.sessions) },
    { label: 'Events', value: fmtNumber(eventCount) },
    { label: 'Observation rows', value: fmtNumber(observationRows) },
    { label: 'Memory files', value: fmtNumber(data.memory_files) },
    { label: 'Skills', value: fmtNumber(data.skills) },
    { label: 'Vault items', value: fmtNumber(data.vault_items) },
    { label: 'Open todos', value: fmtNumber(todos.open) + ' / ' + fmtNumber(todos.total) },
    { label: 'Budget today', value: fmtPercent(budget.percent) }
  ];

  view.appendChild(h('h1', { class: 'page-title' }, 'Overview'));
  view.appendChild(h('p', { class: 'page-sub' },
    'Account ' + text(account.handle) + ' · ' + text(account.displayName) + ' · ' + text(account.email) +
    ' · Dora ' + text(data.version) + ' · uptime ' + fmtDuration(data.uptime_ms)));

  view.appendChild(h('div', { class: 'tiles' }, tiles.map(function (tile) {
    return h('div', { class: 'tile' }, h('div', { class: 'tile-value' }, tile.value), h('div', { class: 'tile-label' }, tile.label));
  })));

  var flagHost = h('div', { class: 'panel' });
  renderFlagList(flagHost);

  view.appendChild(section('Connectors', connectors.length + ' in the catalogue', dataTable([
    { label: 'Connector', render: function (row) { return h('span', {}, h('strong', {}, text(row.title)), h('div', { class: 'mono muted' }, text(row.name))); } },
    { label: 'Actions', align: 'right', render: function (row) { return text(row.implementedActions) + ' / ' + text(row.declaredActions); } },
    { label: 'Auth', render: function (row) { return h('span', { class: 'mono small' }, text(row.authKind)); } },
    { label: 'State', render: function (row) { return connectorStateBadge(!!row.connected); } },
    { label: 'Accounts', align: 'right', render: function (row) { return fmtNumber(row.accounts); } },
    { label: '', render: function (row) {
      if (row.connected) return h('a', { href: '#/connectors', class: 'small' }, 'manage');
      return h('button', { class: 'btn btn-sm', type: 'button', onclick: function () {
        showModal({
          title: 'Connect ' + row.title,
          description: 'Adds a local account for ' + row.title + '. The credential is optional in this build; without it the connector stays fixture-backed.',
          fields: [
            { name: 'label', label: 'Account label', required: true, placeholder: 'work' },
            { name: 'token', label: row.authKind === 'password' ? 'App password (optional)' : 'Access token (optional)', type: 'password' }
          ],
          submitLabel: 'Connect'
        }).then(function (values) {
          if (!values) return null;
          var body = { connector: row.name, label: values.label };
          if (values.token) body.token = values.token;
          return api('/api/connectors/accounts', { method: 'POST', body: body }).then(function () {
            showBanner('Connected ' + row.title + ' as "' + values.label + '".', 'ok');
            refresh();
          });
        }).catch(function (err) { showBanner(err.message, 'error'); });
      } }, 'connect');
    } }
  ], connectors)));

  view.appendChild(section('Feature flags', 'per-account, applied immediately', flagHost));

  view.appendChild(section('Recent browser leases', leases.length + ' held', leases.length ? dataTable([
    { label: 'Lease', render: function (row) { return h('span', { class: 'mono' }, text(row.id)); } },
    { label: 'Session', render: function (row) { return h('span', { class: 'mono' }, text(row.sessionId)); } },
    { label: 'Kind', render: function (row) { return badge(text(row.kind), row.kind === 'write' ? 'warn' : 'none'); } },
    { label: 'Site', render: function (row) { return text(row.site); } },
    { label: 'Acquired', render: function (row) { return fmtTime(row.createdAt); } },
    { label: 'Expires', render: function (row) { return fmtAgo(row.expiresAt); } }
  ], leases) : h('p', { class: 'empty' }, 'No active leases.')));

  view.appendChild(section('Observation sources', sources.length + ' sources', dataTable([
    { label: 'Source', render: function (row) { return h('span', { class: 'mono' }, text(row.source)); } },
    { label: 'Rows', align: 'right', render: function (row) { return fmtNumber(row.rows); } },
    { label: 'Last ingest', render: function (row) { return row.lastIngest ? fmtTime(row.lastIngest) : 'never'; } }
  ], sources)));
}

/* -------------------------------------------------------------- sessions -- */

function eventNode(event) {
  var data = event.data || {};
  return h('article', { class: 'event', dataset: { id: event.id } },
    h('div', { class: 'event-head' },
      h('span', { class: 'badge', 'data-tone': event.type === 'error' ? 'danger' : event.type === 'assistant_message' ? 'ok' : event.type === 'user_message' ? 'accent' : 'none' }, text(event.type)),
      h('span', { class: 'event-seq' }, '#' + text(event.seq)),
      h('span', { class: 'event-seq' }, fmtTime(event.ts))),
    h('pre', {}, jsonText(data)));
}

async function viewSessions(view, query) {
  var results = await Promise.all([
    api('/api/sessions?limit=100'),
    loadFlagsSafe()
  ]);
  var sessions = (results[0] && results[0].sessions) || [];
  var flags = results[1] || {};
  clear(view);

  var detailHost = h('div', { class: 'panel' }, h('p', { class: 'empty' }, 'Select a session to open its event stream.'));

  view.appendChild(h('h1', { class: 'page-title' }, 'Sessions'));
  view.appendChild(h('p', { class: 'page-sub' }, sessions.length + ' session(s) for this account · newest first'));

  var titleInput = h('input', { type: 'text', placeholder: 'Console session', 'aria-label': 'Session title' });
  var kindSelect = h('select', { 'aria-label': 'Session kind' }, h('option', { value: 'main' }, 'main'), h('option', { value: 'task' }, 'task'));
  var channelInput = h('input', { type: 'text', placeholder: 'console', value: 'console', 'aria-label': 'Channel' });
  var createButton = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create session');
  var createForm = h('form', { class: 'row' },
    h('span', { class: 'field' }, 'Kind', kindSelect),
    h('span', { class: 'field', style: 'flex:2 1 220px' }, 'Title', titleInput),
    h('span', { class: 'field' }, 'Channel', channelInput),
    h('span', { class: 'field', style: 'flex:0 0 auto' }, createButton));
  createForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    createButton.disabled = true;
    try {
      await api('/api/sessions', { method: 'POST', body: {
        kind: kindSelect.value,
        title: titleInput.value.trim() || 'Console session',
        channel: channelInput.value.trim() || 'console'
      } });
      showBanner('Session created.', 'ok');
      refresh();
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      createButton.disabled = false;
    }
  });

  view.appendChild(section('New session', 'POST /api/sessions', h('div', { class: 'panel' }, createForm)));

  var table = dataTable([
    { label: 'Kind', render: function (row) { return badge(text(row.kind), row.kind === 'main' ? 'accent' : 'none'); } },
    { label: 'Role', render: function (row) { return h('span', { class: 'mono small' }, text(row.role)); } },
    { label: 'Title', render: function (row) {
      return h('button', { class: 'btn-link', type: 'button', onclick: function () { select(row.id); } }, text(row.title) || '(untitled)');
    } },
    { label: 'Status', render: function (row) { return statusBadge(row.status); } },
    { label: 'Channel', render: function (row) { return text(row.channel); } },
    { label: 'Updated', render: function (row) { return h('span', { title: fmtTime(row.updatedAt) }, fmtAgo(row.updatedAt)); } },
    { label: 'Session id', render: function (row) { return h('span', { class: 'mono small' }, text(row.id)); } }
  ], sessions.map(function (row) {
    var copy = {};
    Object.keys(row).forEach(function (key) { copy[key] = row[key]; });
    return copy;
  }));
  view.appendChild(section('All sessions', 'click a title to open the detail panel', table));

  var detailSection = section('Session detail', 'event stream, live SSE, message composer', detailHost);
  view.appendChild(detailSection);

  var state = { id: null, session: null, events: [], source: null, live: false, streamErrored: false, disposed: false };

  function selectedRow(id) {
    var rows = table.querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i++) {
      rows[i].dataset.selected = sessions[i] && sessions[i].id === id ? 'true' : 'false';
    }
  }

  function appendEvent(event) {
    var list = detailHost.querySelector('.events');
    if (!list) return;
    list.appendChild(eventNode(event));
    list.scrollTop = list.scrollHeight;
  }

  async function loadEvents() {
    if (!state.id) return;
    var data = await api('/api/sessions/' + encodeURIComponent(state.id) + '?since=0&limit=500');
    if (state.disposed || state.id !== (data.session && data.session.id)) return;
    state.session = data.session;
    state.events = data.events || [];
    renderDetail();
  }

  function onStreamEvent(payload) {
    if (!payload || !payload.id) return;
    for (var i = 0; i < state.events.length; i++) if (state.events[i].id === payload.id) return;
    state.events.push(payload);
    appendEvent(payload);
  }

  async function setLive(on) {
    state.live = on;
    if (state.source) { state.source.close(); state.source = null; }
    if (!on || !state.id) { renderDetail(); return; }
    state.streamErrored = false;
    var source = new EventSource(withToken('/api/sessions/' + encodeURIComponent(state.id) + '/stream'));
    state.source = source;
    source.addEventListener('open', function () {
      if (state.streamErrored) { showBanner('Live stream reconnected.', 'ok'); state.streamErrored = false; }
    });
    source.addEventListener('snapshot', function (event) {
      var payload = {};
      try { payload = JSON.parse(event.data); } catch (err) { payload = {}; }
      state.session = payload.session || state.session;
      state.events = payload.events || [];
      renderDetail();
    });
    source.addEventListener('event', function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (err) { payload = null; }
      onStreamEvent(payload);
    });
    source.addEventListener('error', function () {
      if (state.source !== source || state.disposed) return;
      if (!state.streamErrored) {
        state.streamErrored = true;
        showBanner('The live session stream dropped. The browser will keep retrying.', 'warn');
      }
    });
    renderDetail();
  }

  function composer(session) {
    var enabled = !!flags.agent_chat;
    var area = h('textarea', { rows: 3, placeholder: enabled ? 'Message this session…' : '', disabled: !enabled, 'aria-label': 'Message' });
    var send = h('button', { class: 'btn btn-primary', type: 'submit', disabled: !enabled }, 'Send');
    var notice = h('p', { class: enabled ? 'notice subtle' : 'notice' }, enabled ? 'Posts to /api/sessions/' + session.id + '/messages' : 'Agent chat feature not enabled');
    var resultHost = h('div', {});
    var form = h('form', { class: 'stack' }, area, h('div', { class: 'spread' }, notice, send), resultHost);

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var value = area.value.trim();
      if (!value) { showBanner('Type a message first.', 'warn'); return; }
      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        var data = await api('/api/sessions/' + encodeURIComponent(session.id) + '/messages', { method: 'POST', body: { text: value } });
        var result = data && data.result ? data.result : {};
        clear(resultHost);
        resultHost.appendChild(h('div', { class: 'stack' },
          h('div', { class: 'inline' }, badge(text(result.status), result.status === 'completed' ? 'ok' : 'accent'), h('span', { class: 'muted small' }, 'turns: ' + text(result.turns))),
          h('pre', {}, text(result.text))));
        area.value = '';
        await loadEvents();
      } catch (err) {
        var message = err && err.message ? err.message : String(err);
        notice.className = 'notice';
        notice.textContent = message;
        if (err && err.status === 403) {
          area.disabled = true;
          send.disabled = true;
        }
        showBanner(message, 'error');
      } finally {
        if (!send.disabled || !area.disabled) { send.disabled = false; send.textContent = 'Send'; }
      }
    });
    return form;
  }

  function renderDetail() {
    if (!state.session) return;
    var session = state.session;
    clear(detailHost);
    var liveButton = h('button', { class: 'btn' + (state.live ? ' btn-primary' : ''), type: 'button', onclick: function () { void setLive(!state.live); } },
      state.live ? 'Live: on' : 'Live: off');
    var refreshButton = h('button', { class: 'btn', type: 'button', onclick: function () { void loadEvents().catch(function (err) { showBanner(err.message, 'error'); }); } }, 'Reload events');

    detailHost.appendChild(h('div', { class: 'spread' },
      h('div', {},
        h('h3', { class: 'section-title' }, text(session.title) || '(untitled session)'),
        h('div', { class: 'kv' },
          badge(text(session.kind), session.kind === 'main' ? 'accent' : 'none'),
          statusBadge(session.status),
          h('span', { class: 'mono' }, text(session.id)),
          h('span', {}, 'channel ' + text(session.channel)),
          h('span', {}, 'updated ' + fmtTime(session.updatedAt)),
          session.heldReason ? h('span', {}, 'held: ' + text(session.heldReason)) : null,
          flags.agent_chat ? h('a', { href: './agent.html', class: 'small' }, 'open conversation page') : null)),
      h('div', { class: 'inline' }, liveButton, refreshButton)));

    detailHost.appendChild(h('p', { class: 'section-note' }, state.events.length + ' event(s) · newest last'));
    var list = h('div', { class: 'events' });
    state.events.forEach(function (event) { list.appendChild(eventNode(event)); });
    detailHost.appendChild(list);
    list.scrollTop = list.scrollHeight;
    detailHost.appendChild(h('div', { class: 'divider' }));
    detailHost.appendChild(composer(session));
  }

  function select(id) {
    state.id = id;
    var found = null;
    for (var i = 0; i < sessions.length; i++) if (sessions[i].id === id) found = sessions[i];
    state.session = found;
    state.events = [];
    try { window.history.replaceState(null, '', '#/sessions?session=' + encodeURIComponent(id)); } catch (err) { /* deep links are a convenience */ }
    selectedRow(id);
    clear(detailHost);
    detailHost.appendChild(loading('Loading events…'));
    loadEvents().catch(function (err) {
      clear(detailHost);
      detailHost.appendChild(h('p', { class: 'empty' }, err.message));
      showBanner(err.message, 'error');
    });
  }

  table.addEventListener('click', function (event) {
    if (event.target.closest('button')) return;
    var row = event.target.closest('tr');
    if (!row || !row.parentElement) return;
    var index = Array.prototype.indexOf.call(row.parentElement.children, row);
    if (sessions[index]) select(sessions[index].id);
  });

  var initial = query.get('session') || (sessions[0] ? sessions[0].id : null);
  if (initial) select(initial);

  return function dispose() {
    state.disposed = true;
    if (state.source) { state.source.close(); state.source = null; }
  };
}

/* ------------------------------------------------------------ connectors -- */

function connectorCard(connector, onChanged) {
  var accounts = connector.accounts || [];
  var card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', { class: 'card-title' }, text(connector.title)),
      h('span', { class: 'mono small muted' }, text(connector.name)),
      connectorStateBadge(!!connector.connected)),
    h('p', { class: 'card-desc' }, text(connector.description)),
    h('div', { class: 'kv' },
      h('span', {}, 'actions ' + text(connector.implementedActions) + ' / ' + text(connector.declaredActions) + ' implemented'),
      h('span', {}, 'auth ' + text(connector.authKind))),
    h('hr', { class: 'divider' }));

  if (accounts.length === 0) {
    card.appendChild(h('p', { class: 'empty' }, connector.authKind === 'none' ? 'No account needed for this connector.' : 'No account connected.'));
  } else {
    card.appendChild(h('div', { class: 'stack' }, accounts.map(function (account) {
      var disconnect = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Disconnect');
      disconnect.addEventListener('click', async function () {
        disconnect.disabled = true;
        disconnect.textContent = 'Disconnecting…';
        try {
          await api('/api/connectors/accounts/' + encodeURIComponent(account.id), { method: 'DELETE' });
          showBanner('Disconnected "' + account.label + '".', 'ok');
          onChanged();
        } catch (err) {
          showBanner(err.message, 'error');
          disconnect.disabled = false;
          disconnect.textContent = 'Disconnect';
        }
      });
      return h('div', { class: 'spread' },
        h('div', {},
          h('div', {}, h('strong', {}, text(account.label)), account.isDefault ? ' ' : '', account.isDefault ? badge('default', 'accent') : null),
          h('div', { class: 'mono small muted' }, text(account.id) + ' · added ' + fmtTime(account.createdAt) + ' · ' + text(account.authKind))),
        disconnect);
    })));
  }

  card.appendChild(h('hr', { class: 'divider' }));
  card.appendChild(accountRowForm(connector, onChanged, false));
  return card;
}

async function viewConnectors(view) {
  var data = await api('/api/connectors');
  var connectors = data.connectors || [];
  clear(view);

  var connected = connectors.filter(function (c) { return c.connected; }).length;
  view.appendChild(h('h1', { class: 'page-title' }, 'Connectors'));
  view.appendChild(h('p', { class: 'page-sub' }, connected + ' of ' + connectors.length + ' connected · a connector is a local account, never a vendor OAuth app'));

  var filter = h('input', { type: 'search', placeholder: 'Filter connectors…', 'aria-label': 'Filter connectors' });
  var grid = h('div', { class: 'grid grid-cards' });

  function renderCards() {
    var needle = filter.value.trim().toLowerCase();
    var list = connectors.filter(function (connector) {
      if (!needle) return true;
      return (connector.name + ' ' + connector.title + ' ' + connector.description).toLowerCase().indexOf(needle) !== -1;
    });
    clear(grid);
    if (list.length === 0) { grid.appendChild(h('p', { class: 'empty' }, 'No connector matches that filter.')); return; }
    list.forEach(function (connector) { grid.appendChild(connectorCard(connector, refresh)); });
  }

  filter.addEventListener('input', renderCards);
  view.appendChild(h('div', { class: 'panel' }, h('div', { class: 'row' }, h('span', { class: 'field' }, filter))));
  view.appendChild(h('div', { style: 'height:16px' }));
  view.appendChild(grid);
  renderCards();
}

/* ----------------------------------------------------------------- tools -- */

function tokenizeCommand(input) {
  var out = [];
  var current = '';
  var quote = null;
  var started = false;
  for (var i = 0; i < input.length; i++) {
    var char = input.charAt(i);
    if (quote) {
      if (char === quote) { quote = null; }
      else if (char === '\\' && quote === '"' && i + 1 < input.length) { current += input.charAt(++i); }
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (current || started) { out.push(current); current = ''; started = false; }
    } else {
      current += char;
    }
  }
  if (current || started) out.push(current);
  return out;
}

async function viewTools(view, query) {
  var results = await Promise.all([
    api('/api/tools'),
    api('/api/sessions?limit=50').catch(function () { return { sessions: [] }; })
  ]);
  var data = results[0] || {};
  var sessions = (results[1] && results[1].sessions) || [];
  var families = data.families || [];
  var actions = data.actions || [];
  var singles = data.singles || [];
  clear(view);

  view.appendChild(h('h1', { class: 'page-title' }, 'Tools'));
  view.appendChild(h('p', { class: 'page-sub' },
    fmtNumber(data.total) + ' actions routed · ' + fmtNumber(data.declared_total) + ' declared in the catalogue · ' + families.length + ' families'));

  view.appendChild(section('Families', 'declared counts are what the family advertises; implemented counts are what this build routes', dataTable([
    { label: 'Family', render: function (row) { return h('span', {}, h('strong', {}, text(row.name)), h('div', { class: 'muted small' }, text(row.title))); } },
    { label: 'Implemented / declared', align: 'right', render: function (row) { return text(row.implemented) + ' / ' + text(row.actions); } },
    { label: 'Connector', render: function (row) { return row.connected ? badge('connected', 'ok') : badge('names only', 'none'); } },
    { label: '', render: function (row) { return h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { loadHelp(row.name); } }, 'help'); } }
  ], families)));

  if (singles.length > 0) {
    view.appendChild(section('Single actions', singles.length + ' not in a family', h('div', { class: 'panel' }, h('p', { class: 'mono small' }, singles.join(', ')))));
  }

  var helpPath = h('span', { class: 'path-crumbs' }, 'no action selected');
  var helpBody = h('pre', { class: 'tall' }, 'Pick help on a family, or search an action below and open its page.');
  var helpHost = h('div', { class: 'panel' }, h('div', { class: 'spread' }, h('h3', { class: 'section-title' }, 'Help viewer'), helpPath), helpBody);

  async function loadHelp(path) {
    helpPath.textContent = path;
    clear(helpBody);
    helpBody.appendChild(loading('Loading ' + path + ' help…'));
    try {
      var help = await api('/api/tools/' + encodeURIComponent(path) + '/help');
      helpBody.textContent = text(help.page);
      try { window.history.replaceState(null, '', '#/tools?path=' + encodeURIComponent(help.path || path)); } catch (err) { /* optional */ }
    } catch (err) {
      helpBody.textContent = err.message;
      helpBody.className = 'tall error-text';
      showBanner(err.message, 'error');
    }
  }

  var search = h('input', { type: 'search', placeholder: 'Search actions by path, family, trait or summary…', 'aria-label': 'Search actions' });
  var actionList = h('div', { class: 'list', style: 'max-height:36vh' });
  var actionCount = h('span', { class: 'section-note' }, actions.length + ' actions');

  function renderActions() {
    var needle = search.value.trim().toLowerCase();
    var matches = actions.filter(function (action) {
      if (!needle) return true;
      return (action.path + ' ' + action.family + ' ' + action.trait + ' ' + (action.connector || '') + ' ' + action.summary).toLowerCase().indexOf(needle) !== -1;
    });
    clear(actionList);
    actionCount.textContent = matches.length + ' of ' + actions.length + ' actions';
    if (matches.length === 0) { actionList.appendChild(h('p', { class: 'empty' }, 'No action matches.')); return; }
    matches.slice(0, 200).forEach(function (action) {
      actionList.appendChild(h('button', { class: 'list-item', type: 'button', onclick: function () { void loadHelp(action.path); } },
        h('div', { class: 'list-item-title mono' }, text(action.path)),
        h('div', { class: 'list-item-meta' }, text(action.family) + ' · ' + text(action.trait) + (action.connector ? ' · connector ' + action.connector : '') + (action.has_output_json ? ' · output json' : '')),
        h('div', { class: 'small muted' }, text(action.summary))));
    });
    if (matches.length > 200) actionList.appendChild(h('p', { class: 'empty' }, 'Showing the first 200 matches; refine the search to see more.'));
  }

  search.addEventListener('input', renderActions);
  renderActions();

  view.appendChild(section('Action browser', 'click an action to load its help page', h('div', { class: 'grid grid-2' },
    h('div', { class: 'panel' }, h('div', { class: 'stack' }, search, actionCount), h('div', { style: 'height:8px' }), actionList),
    helpHost)));

  var execInput = h('input', { type: 'text', value: 'help', placeholder: 'help gmail', 'aria-label': 'Tools command', spellcheck: 'false' });
  var sessionSelect = h('select', { 'aria-label': 'Session for the run' }, h('option', { value: '' }, '(main session)'));
  sessions.forEach(function (session) {
    sessionSelect.appendChild(h('option', { value: session.id }, text(session.title) || text(session.id)));
  });
  var execButton = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Run');
  var execOutput = h('div', {});
  var execForm = h('form', { class: 'stack' },
    h('div', { class: 'row' }, h('span', { class: 'field', style: 'flex:3 1 320px' }, execInput), h('span', { class: 'field', style: 'flex:1 1 200px' }, sessionSelect), h('span', { class: 'field', style: 'flex:0 0 auto' }, execButton)),
    h('p', { class: 'small muted' }, 'Pass the command exactly as the sandbox CLI would: a family and an action, or a dotted path, then flags. Example: help gmail'),
    execOutput);

  execForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    var argv = tokenizeCommand(execInput.value.trim());
    if (argv.length === 0) { showBanner('Enter a tools command, for example: help', 'warn'); execInput.focus(); return; }
    execButton.disabled = true;
    execButton.textContent = 'Running…';
    clear(execOutput);
    execOutput.appendChild(loading('Running tools ' + argv.join(' ') + '…'));
    try {
      var body = { argv: argv };
      if (sessionSelect.value) body.session_id = sessionSelect.value;
      var result = await api('/api/tools/exec', { method: 'POST', body: body });
      renderExec(execOutput, result);
    } catch (err) {
      clear(execOutput);
      execOutput.appendChild(h('pre', { class: 'error-text' }, err.message));
      showBanner(err.message, 'error');
    } finally {
      execButton.disabled = false;
      execButton.textContent = 'Run';
    }
  });

  function renderExec(host, result) {
    clear(host);
    host.appendChild(h('div', { class: 'inline' },
      badge('exit ' + text(result.exitCode), result.exitCode === 0 ? 'ok' : 'danger'),
      h('span', { class: 'muted small' }, (result.attachments || []).length + ' attachment(s)')));
    host.appendChild(h('h4', { class: 'section-note' }, 'stdout'));
    host.appendChild(h('pre', {}, result.stdout ? result.stdout : '(empty)'));
    host.appendChild(h('h4', { class: 'section-note' }, 'stderr'));
    host.appendChild(h('pre', { class: result.stderr ? 'error-text' : '' }, result.stderr ? result.stderr : '(empty)'));
    var attachments = result.attachments || [];
    if (attachments.length > 0) {
      host.appendChild(h('h4', { class: 'section-note' }, 'attachments'));
      host.appendChild(h('div', { class: 'stack' }, attachments.map(function (attachment) {
        return h('div', { class: 'panel' },
          h('div', { class: 'inline' }, h('strong', { class: 'mono' }, text(attachment.name)), badge(text(attachment.kind), 'accent'), h('span', { class: 'muted small' }, text(attachment.mime)), attachment.truncated ? badge('truncated', 'warn') : null),
          h('pre', {}, text(attachment.content)));
      })));
    }
  }

  view.appendChild(section('Run a tools command', 'POST /api/tools/exec', h('div', { class: 'panel' }, execForm)));

  var requested = query.get('path');
  if (requested) void loadHelp(requested);
}

/* ---------------------------------------------------------------- skills -- */

async function viewSkills(view, query) {
  var data = await api('/api/skills');
  var skills = (data && data.skills) || [];
  clear(view);

  view.appendChild(h('h1', { class: 'page-title' }, 'Skills'));
  view.appendChild(h('p', { class: 'page-sub' }, skills.length + ' skill(s) in the library · bodies render as plain text'));

  var bodyHost = h('div', { class: 'panel' }, h('p', { class: 'empty' }, 'Select a skill to read its body.'));
  var list = h('div', { class: 'list' });
  var selectedId = query.get('id');
  var buttons = [];

  function show(skill) {
    selectedId = skill.id;
    buttons.forEach(function (entry) { entry.button.setAttribute('aria-selected', entry.skill.id === skill.id ? 'true' : 'false'); });
    try { window.history.replaceState(null, '', '#/skills?id=' + encodeURIComponent(skill.id)); } catch (err) { /* optional */ }
    clear(bodyHost);
    bodyHost.appendChild(h('div', { class: 'spread' },
      h('div', {},
        h('h3', { class: 'section-title' }, text(skill.name)),
        h('div', { class: 'kv' },
          h('span', { class: 'mono' }, text(skill.id)),
          (skill.roles || []).map(function (role) { return badge(role, 'accent'); }),
          h('span', {}, (skill.references || []).length + ' reference(s)'),
          skill.hasBody ? badge('body', 'ok') : badge('no body', 'none'))),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { void navigator.clipboard.writeText(String(skill.body || '')).then(function () { showBanner('Skill body copied.', 'ok'); }, function () { showBanner('Copy failed — select the text manually.', 'warn'); }); } }, 'Copy body')));
    bodyHost.appendChild(h('p', { class: 'card-desc' }, text(skill.description)));
    if (skill.roles && skill.roles.length > 0) {
      bodyHost.appendChild(h('p', { class: 'small muted' }, 'roles: ' + skill.roles.join(', ')));
    }
    if (skill.references && skill.references.length > 0) {
      bodyHost.appendChild(h('div', { class: 'panel' }, h('h4', { class: 'section-note' }, 'References'), h('ul', {}, skill.references.map(function (reference) { return h('li', { class: 'mono small' }, text(reference)); }))));
    }
    bodyHost.appendChild(h('h4', { class: 'section-note' }, 'Body'));
    bodyHost.appendChild(h('pre', { class: 'tall' }, skill.body ? String(skill.body) : '(no body for this account’s flags)'));
  }

  if (skills.length === 0) list.appendChild(h('p', { class: 'empty' }, 'No skills installed.'));
  skills.forEach(function (skill) {
    var button = h('button', { class: 'list-item', type: 'button', onclick: function () { show(skill); } },
      h('div', { class: 'list-item-title' }, text(skill.name)),
      h('div', { class: 'list-item-meta mono' }, text(skill.id)),
      h('div', { class: 'list-item-meta' }, (skill.roles || []).join(', ') + ((skill.references || []).length ? ' · ' + skill.references.length + ' refs' : '')),
      h('div', { class: 'small muted' }, text(skill.description)));
    buttons.push({ button: button, skill: skill });
    list.appendChild(button);
  });

  view.appendChild(h('div', { class: 'grid grid-2' }, list, bodyHost));

  var initial = null;
  for (var i = 0; i < skills.length; i++) if (skills[i].id === selectedId) initial = skills[i];
  if (initial) show(initial);
}

/* ---------------------------------------------------------------- memory -- */

async function viewMemory(view, query) {
  var data = await api('/api/memory');
  var files = (data && data.files) || [];
  var stats = data && data.stats ? data.stats : null;
  clear(view);

  view.appendChild(h('h1', { class: 'page-title' }, 'Memory'));
  view.appendChild(h('p', { class: 'page-sub' },
    files.length + ' markdown file(s)' + (stats ? ' · ' + bytes(stats.bytes) + ' · ' + (stats.lastCommit ? 'HEAD ' + String(stats.lastCommit).slice(0, 10) : 'no commits') : '')));

  var pathInput = h('input', { type: 'text', placeholder: 'knowledge/facts/example.md', 'aria-label': 'Memory path', spellcheck: 'false' });
  var typeInput = h('input', { type: 'text', placeholder: 'note', 'aria-label': 'Memory type' });
  var bodyArea = h('textarea', { rows: 18, placeholder: 'Markdown body…', 'aria-label': 'Memory body', spellcheck: 'false' });
  var saveButton = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save file');
  var preview = h('p', { class: 'small muted' }, 'Select a file to edit, or type a new path.');
  var list = h('div', { class: 'list' });
  var selectedPath = query.get('path') || '';

  function renderList() {
    clear(list);
    if (files.length === 0) { list.appendChild(h('p', { class: 'empty' }, 'The memory repo is empty.')); return; }
    files.forEach(function (file) {
      var first = String(file.body || '').split('\n').find(function (line) { return line.trim().length > 0; }) || '(empty)';
      list.appendChild(h('button', {
        class: 'list-item',
        type: 'button',
        'aria-selected': file.path === selectedPath ? 'true' : 'false',
        onclick: function () { select(file); }
      },
        h('div', { class: 'list-item-title mono' }, text(file.path)),
        h('div', { class: 'list-item-meta' }, text(file.type) + ' · ' + fmtTime(file.lastModified)),
        h('div', { class: 'small muted' }, first.slice(0, 120))));
    });
  }

  function select(file) {
    selectedPath = file.path;
    pathInput.value = file.path;
    typeInput.value = file.type || '';
    bodyArea.value = file.body || '';
    preview.textContent = 'Editing ' + file.path + ' · updated ' + fmtTime(file.lastModified) + ' · id ' + text(file.id);
    renderList();
    try { window.history.replaceState(null, '', '#/memory?path=' + encodeURIComponent(file.path)); } catch (err) { /* optional */ }
  }

  var form = h('form', { class: 'stack' },
    h('div', { class: 'row' },
      h('span', { class: 'field', style: 'flex:3 1 260px' }, 'Path', pathInput),
      h('span', { class: 'field', style: 'flex:1 1 140px' }, 'Type', typeInput),
      h('span', { class: 'field', style: 'flex:0 0 auto' }, saveButton)),
    preview,
    bodyArea);

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var path = pathInput.value.trim();
    if (!path) { showBanner('A memory path is required.', 'warn'); pathInput.focus(); return; }
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      var result = await api('/api/memory/file', { method: 'POST', body: { path: path, body: bodyArea.value, type: typeInput.value.trim() || undefined } });
      var saved = result && result.file ? result.file : null;
      if (saved) {
        var replaced = false;
        files = files.map(function (file) { if (file.path === saved.path) { replaced = true; return saved; } return file; });
        if (!replaced) files.unshift(saved);
        selectedPath = saved.path;
      }
      renderList();
      showBanner('Saved ' + path + (result && result.commit ? ' (commit ' + String(result.commit).slice(0, 10) + ')' : ' (no git commit)') + '.', 'ok');
      preview.textContent = 'Saved ' + path + '.';
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save file';
    }
  });

  var newButton = h('button', { class: 'btn', type: 'button', onclick: function () {
    selectedPath = '';
    pathInput.value = '';
    typeInput.value = '';
    bodyArea.value = '';
    preview.textContent = 'New file — the path decides where it lands in the repo.';
    renderList();
    pathInput.focus();
  } }, 'New file');

  view.appendChild(h('div', { class: 'grid grid-2' },
    h('div', { class: 'panel' }, h('div', { class: 'spread' }, h('h3', { class: 'section-title' }, 'Repository'), newButton), list),
    h('div', { class: 'panel' }, h('h3', { class: 'section-title' }, 'Editor'), form)));

  renderList();

  var initial = null;
  for (var i = 0; i < files.length; i++) if (files[i].path === selectedPath) initial = files[i];
  if (initial) select(initial);
}

/* ---------------------------------------------------------- observations -- */

async function viewObservations(view) {
  var data = await api('/api/observations');
  var sources = (data && data.sources) || [];
  clear(view);

  var totalRows = sources.reduce(function (sum, source) { return sum + (source.rows || 0); }, 0);
  view.appendChild(h('h1', { class: 'page-title' }, 'Observations'));
  view.appendChild(h('p', { class: 'page-sub' }, sources.length + ' source(s) · ' + fmtNumber(totalRows) + ' rows in the local observations database'));

  view.appendChild(section('Sources', 'one view per source, queried with SQL', dataTable([
    { label: 'Source', render: function (row) { return h('span', { class: 'mono' }, text(row.source)); } },
    { label: 'Rows', align: 'right', render: function (row) { return fmtNumber(row.rows); } },
    { label: 'Last ingest', render: function (row) { return row.lastIngest ? fmtTime(row.lastIngest) : 'never'; } },
    { label: '', render: function (row) { return h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { queryArea.value = 'SELECT * FROM "' + row.source + '" LIMIT 20'; queryArea.focus(); } }, 'query'); } }
  ], sources)));

  var queryArea = h('textarea', { rows: 4, spellcheck: 'false', placeholder: 'SELECT * FROM gmail LIMIT 20', 'aria-label': 'SQL query' });
  var runButton = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Run query');
  var resultHost = h('div', {});
  var form = h('form', { class: 'stack' }, queryArea, h('div', { class: 'inline' }, runButton,
    h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { queryArea.value = 'SELECT * FROM gmail LIMIT 20'; } }, 'gmail sample'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { queryArea.value = 'SELECT source, COUNT(*) AS rows FROM observations GROUP BY source'; } }, 'count by source')), resultHost);

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var query = queryArea.value.trim();
    if (!query) { showBanner('Enter a SELECT query.', 'warn'); queryArea.focus(); return; }
    runButton.disabled = true;
    runButton.textContent = 'Running…';
    clear(resultHost);
    resultHost.appendChild(loading('Running query…'));
    try {
      var result = await api('/api/observations/sql', { method: 'POST', body: { query: query } });
      clear(resultHost);
      var columns = result.columns || [];
      var rows = (result.rows || []).map(function (row) {
        var copy = {};
        columns.forEach(function (column) { copy[column] = row[column]; });
        return copy;
      });
      resultHost.appendChild(h('div', { class: 'inline' },
        badge(fmtNumber(rows.length) + ' rows', 'ok'),
        h('span', { class: 'muted small' }, text(result.ms) + ' ms'),
        result.truncated ? badge('truncated', 'warn') : null));
      resultHost.appendChild(dataTable(columns.map(function (column) {
        return { label: column, key: column, render: function (row) { var value = row[column]; return typeof value === 'object' && value !== null ? jsonText(value) : (value === null || value === undefined ? 'NULL' : String(value)); } };
      }), rows));
    } catch (err) {
      clear(resultHost);
      resultHost.appendChild(h('pre', { class: 'error-text' }, err.message));
      showBanner(err.message, 'error');
    } finally {
      runButton.disabled = false;
      runButton.textContent = 'Run query';
    }
  });

  view.appendChild(section('SQL', 'SELECT and WITH only — the guard messages are shown verbatim', h('div', { class: 'panel' }, form)));
}

/* ----------------------------------------------------------------- vault -- */

async function viewVault(view) {
  var data = await api('/api/vault');
  var items = (data && data.items) || [];
  var links = (data && data.links) || [];
  clear(view);

  view.appendChild(h('h1', { class: 'page-title' }, 'Vault'));
  view.appendChild(h('p', { class: 'page-sub' }, items.length + ' item(s) · secrets are never returned by the API, only field names'));

  view.appendChild(section('Items', 'labels, kinds and field names only', dataTable([
    { label: 'Label', render: function (row) { return h('strong', {}, text(row.label)); } },
    { label: 'Kind', render: function (row) { return badge(text(row.kind), 'accent'); } },
    { label: 'Fields', render: function (row) { return (row.fields || []).join(', ') || '—'; } },
    { label: 'Updated', render: function (row) { return fmtTime(row.updatedAt); } },
    { label: 'Item id', render: function (row) { return h('span', { class: 'mono small' }, text(row.id)); } }
  ], items)));

  var labelInput = h('input', { type: 'text', placeholder: 'card on file', 'aria-label': 'Link label' });
  var kindSelect = h('select', { 'aria-label': 'Link kind' }, ['password', 'card', 'address', 'phone', 'identity', 'note'].map(function (kind) {
    return h('option', { value: kind }, kind);
  }));
  var fieldsInput = h('input', { type: 'text', value: 'password', placeholder: 'password, otp', 'aria-label': 'Fields' });
  var createButton = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create fill link');
  var linkHost = h('div', {});
  var form = h('form', { class: 'stack' },
    h('div', { class: 'row' },
      h('span', { class: 'field', style: 'flex:2 1 200px' }, 'Label', labelInput),
      h('span', { class: 'field', style: 'flex:1 1 140px' }, 'Kind', kindSelect),
      h('span', { class: 'field', style: 'flex:2 1 200px' }, 'Fields (comma separated)', fieldsInput),
      h('span', { class: 'field', style: 'flex:0 0 auto' }, createButton)),
    h('p', { class: 'small muted' }, 'The member opens the returned URL, types the secret there, and Dora places it without ever reading it back.'),
    linkHost);

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var fields = fieldsInput.value.split(',').map(function (value) { return value.trim(); }).filter(Boolean);
    createButton.disabled = true;
    createButton.textContent = 'Creating…';
    try {
      var link = await api('/api/vault/links', { method: 'POST', body: {
        label: labelInput.value.trim() || 'item',
        kind: kindSelect.value,
        fields: fields.length > 0 ? fields : ['password']
      } });
      clear(linkHost);
      var urlInput = h('input', { type: 'text', readonly: true, value: link.url || '', 'aria-label': 'Fill link URL' });
      var copyButton = h('button', { class: 'btn', type: 'button', onclick: function () {
        var value = String(link.url || '');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(function () { showBanner('Fill link copied to the clipboard.', 'ok'); }, function () { selectFallback(); });
        } else selectFallback();
        function selectFallback() {
          try { urlInput.focus(); urlInput.select(); document.execCommand('copy'); showBanner('Fill link copied.', 'ok'); }
          catch (err) { showBanner('Copy failed — select the URL and copy it manually.', 'warn'); }
        }
      } }, 'Copy');
      linkHost.appendChild(h('div', { class: 'stack' },
        h('div', { class: 'inline' }, badge('one-time link', 'ok'), h('span', { class: 'muted small' }, 'expires ' + fmtTime(link.expiresAt))),
        h('div', { class: 'row' }, h('span', { class: 'field', style: 'flex:1 1 320px' }, urlInput), h('span', { class: 'field', style: 'flex:0 0 auto' }, copyButton))));
      showBanner('Fill link created.', 'ok');
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      createButton.disabled = false;
      createButton.textContent = 'Create fill link';
    }
  });

  view.appendChild(section('Create a fill link', 'POST /api/vault/links', h('div', { class: 'panel' }, form)));

  view.appendChild(section('Pending links', links.length + ' outstanding', links.length ? dataTable([
    { label: 'Label', render: function (row) { return text(row.label); } },
    { label: 'Token', render: function (row) { return h('span', { class: 'mono small' }, String(row.token || '').slice(0, 12) + '…'); } },
    { label: 'Expires', render: function (row) { return fmtTime(row.expiresAt); } },
    { label: 'Used', render: function (row) { return row.used ? badge('used', 'ok') : badge('unused', 'warn'); } }
  ], links) : h('p', { class: 'empty' }, 'No pending fill links.')));
}

/* -------------------------------------------------------------- channels -- */

async function viewChannels(view) {
  var data = await api('/api/channels?limit=50');
  var channels = (data && data.channels) || [];
  var messages = (data && data.messages) || [];
  clear(view);

  view.appendChild(h('h1', { class: 'page-title' }, 'Channels'));
  view.appendChild(h('p', { class: 'page-sub' }, channels.length + ' channel(s) · ' + messages.length + ' recent console message(s)'));

  var messageHost = h('div', {});

  function renderMessages(list) {
    clear(messageHost);
    messageHost.appendChild(dataTable([
      { label: 'Direction', render: function (row) { return badge(text(row.direction), row.direction === 'inbound' ? 'accent' : 'ok'); } },
      { label: 'Channel', render: function (row) { return h('span', { class: 'mono small' }, text(row.channel)); } },
      { label: 'From', render: function (row) { return text(row.from); } },
      { label: 'To', render: function (row) { return text(row.to); } },
      { label: 'Body', render: function (row) { return h('div', { style: 'max-width:52ch;white-space:pre-wrap' }, text(row.body)); } },
      { label: 'Thread', render: function (row) { return h('span', { class: 'mono small' }, text(row.threadId)); } },
      { label: 'Time', render: function (row) { return h('span', { title: fmtTime(row.ts) }, fmtAgo(row.ts)); } }
    ], list));
  }

  view.appendChild(h('div', { class: 'panel' }, h('div', { class: 'inline' }, channels.map(function (channel) { return badge(channel, 'accent'); }))));
  view.appendChild(h('div', { style: 'height:16px' }));
  view.appendChild(section('Recent messages', 'console channel history', messageHost));
  renderMessages(messages);

  var channelSelect = h('select', { 'aria-label': 'Channel' }, (channels.length ? channels : ['console']).map(function (channel) { return h('option', { value: channel }, channel); }));
  var fromInput = h('input', { type: 'text', value: '+15550000000', 'aria-label': 'From' });
  var toInput = h('input', { type: 'text', value: 'dora', 'aria-label': 'To' });
  var bodyArea = h('textarea', { rows: 3, placeholder: 'Simulated inbound message…', 'aria-label': 'Message body' });
  var runCheck = h('input', { type: 'checkbox' });
  var sendButton = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Deliver inbound');
  var resultHost = h('div', {});

  var form = h('form', { class: 'stack' },
    h('div', { class: 'row' },
      h('span', { class: 'field', style: 'flex:1 1 160px' }, 'Channel', channelSelect),
      h('span', { class: 'field', style: 'flex:1 1 180px' }, 'From', fromInput),
      h('span', { class: 'field', style: 'flex:1 1 160px' }, 'To', toInput)),
    h('span', { class: 'field' }, 'Body', bodyArea),
    h('div', { class: 'spread' },
      h('label', { class: 'check' }, runCheck, h('span', {}, 'run the agent')),
      sendButton),
    resultHost);

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var body = bodyArea.value.trim();
    if (!body) { showBanner('A message body is required.', 'warn'); bodyArea.focus(); return; }
    sendButton.disabled = true;
    sendButton.textContent = 'Delivering…';
    clear(resultHost);
    resultHost.appendChild(loading('Delivering…'));
    try {
      var result = await api('/api/channels/inbound', { method: 'POST', body: {
        channel: channelSelect.value,
        from: fromInput.value.trim(),
        to: toInput.value.trim(),
        body: body,
        run: runCheck.checked
      } });
      clear(resultHost);
      var message = result && result.message ? result.message : {};
      resultHost.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'inline' }, badge(text(message.direction) || 'inbound', 'accent'), h('span', { class: 'mono small' }, text(message.channel)), h('span', { class: 'muted small' }, fmtTime(message.ts))),
        h('p', { class: 'msg-body' }, text(message.body)),
        result && result.run ? h('div', { class: 'stack' },
          h('div', { class: 'inline' }, badge(text(result.run.status), result.run.status === 'completed' ? 'ok' : 'accent'), h('span', { class: 'muted small' }, 'turns: ' + text(result.run.turns))),
          h('pre', {}, text(result.run.text))) : h('p', { class: 'small muted' }, 'The agent was not run for this message.')));
      bodyArea.value = '';
      var refreshed = await api('/api/channels?limit=50').catch(function () { return null; });
      if (refreshed && refreshed.messages) renderMessages(refreshed.messages);
      showBanner('Inbound message recorded.', 'ok');
    } catch (err) {
      clear(resultHost);
      resultHost.appendChild(h('pre', { class: 'error-text' }, err.message));
      showBanner(err.message, 'error');
    } finally {
      sendButton.disabled = false;
      sendButton.textContent = 'Deliver inbound';
    }
  });

  view.appendChild(section('Simulate an inbound message', 'POST /api/channels/inbound', h('div', { class: 'panel' }, form)));
}

/* ------------------------------------------------------------------ boot -- */

async function boot() {
  bannerEl = document.getElementById('banner');
  bannerTextEl = document.getElementById('banner-text');
  document.getElementById('banner-dismiss').addEventListener('click', hideBanner);

  // The URL printed by `dora serve` carries ?token=... — capture it before the first
  // API call, otherwise every request is anonymous and the console shows a 401 modal.
  storeToken(readTokenFromQuery() || storedToken());

  document.getElementById('token-button').addEventListener('click', function () {
    void promptForToken('Set or replace the admin token.').then(function (value) {
      if (value) { showBanner('Token saved.', 'ok'); refreshHealth(); void routeTo(); }
    });
  });
  document.getElementById('stream-chip').addEventListener('click', toggleGlobalStream);

  buildNav();
  window.addEventListener('hashchange', function () { void routeTo(); });

  await refreshHealth();
  await routeTo();
}

void boot();
