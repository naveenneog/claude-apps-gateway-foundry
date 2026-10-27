// Shared DOM toolkit for the admin-ui pages: the API client, element and icon builders, page and card scaffolding,
// banners, skeletons, toasts, <dialog> confirmations and client-side downloads. Classic script, loaded after the pure
// view helpers and before the page scripts; no framework, nothing fetched from another origin.
const app = document.getElementById('app');

// A failed call throws an Error with the server's message, plus status and the parsed body for callers that branch.
const api = (() => {
  async function request(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status, body: json });
    return json;
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path, body) => request('DELETE', path, body),
  };
})();

// el('tag', { class, text, onclick, ...attributes }, children). false, null and undefined attributes and children
// are skipped, so conditional parts read inline; true sets an empty (boolean) attribute.
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

const ui = (() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    alert: 'M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18zM12 7.5v5.5M12 16.5h.01',
    info: 'M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18zM12 11v5.5M12 7.5h.01',
    warning: 'M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0zM12 9.5v4.5M12 17h.01',
    download: 'M12 4v11M7 10.5l5 5 5-5M5 19.5h14',
    upload: 'M12 20V9M7 13.5l5-5 5 5M5 4.5h14',
    plus: 'M12 5v14M5 12h14',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    trash: 'M4.5 7h15M10 4h4M6.5 7l1 13h9l1-13',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4.5V11h-6.5',
    lock: 'M7 10.5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 10.5V8a4 4 0 0 1 8 0v2.5',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    terminal: 'M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2zM7 9.5l3 2.5-3 2.5M12.5 15h4.5',
    desktop: 'M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8.5 20h7M12 16v4',
    trend: 'M3.5 16.5l5-5 4 4 8-8M14.5 7.5h6v6',
    gauge: 'M6 19a8.5 8.5 0 1 1 12 0M12 13l3.5-3.5',
    history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 3.5v4h4M12 7.5V12l3 2',
    users: 'M9 4.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7zM2.5 20c.7-3.4 3.2-5.5 6.5-5.5s5.8 2.1 6.5 5.5M15.5 4.7a3.5 3.5 0 0 1 0 6.6M18 14.9c1.9.8 3.1 2.5 3.5 5.1',
    clock: 'M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18zM12 7.5V12l3 2',
    shield: 'M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6zM8.5 12l2.5 2.5 4.5-5',
    file: 'M6 3.5h8l4.5 4.5v12a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5zM13.5 3.5V8.5h5',
    filter: 'M4 5h16l-6.5 7.5V19l-3-1.5v-5z',
  };
  let ids = 0;
  const uid = (prefix) => `${prefix}-${(ids += 1)}`;

  function icon(name, size = 16) {
    const svg = document.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(k, v);
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', ICONS[name] ?? ICONS.info);
    svg.append(path);
    return svg;
  }

  const button = (text, { kind = 'secondary', iconName, size, ...attrs } = {}) => el('button', { type: 'button', class: ['btn', kind, size].filter(Boolean).join(' '), ...attrs }, [iconName && icon(iconName), el('span', { text })]);

  function busy(btn, on, text) {
    if (on) {
      btn.dataset.label = btn.querySelector('span')?.textContent ?? '';
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      if (text && btn.querySelector('span')) btn.querySelector('span').textContent = text;
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (btn.dataset.label && btn.querySelector('span')) btn.querySelector('span').textContent = btn.dataset.label;
    }
  }

  const pageHeader = ({ title, description, actions = [] }) => el('header', { class: 'page-header' }, [
    el('div', { class: 'page-title' }, [el('h2', { text: title }), description && el('p', { text: description })]),
    actions.length ? el('div', { class: 'page-actions' }, actions) : null,
  ]);

  function card({ title, description, actions = [], content = [], className = '', id }) {
    const titleId = title ? `${id ?? uid('card')}-title` : null;
    return el('section', { class: `card ${className}`.trim(), id, 'aria-labelledby': titleId }, [
      title || actions.length ? el('div', { class: 'card-header' }, [
        el('div', { class: 'card-title' }, [title && el('h3', { id: titleId, text: title }), description && el('p', { text: description })]),
        actions.length ? el('div', { class: 'card-actions' }, actions) : null,
      ]) : null,
      ...[].concat(content),
    ]);
  }

  const BANNER_ICON = { error: 'alert', warning: 'warning', info: 'info', success: 'check' };
  function banner(kind, message, { title, actions = [] } = {}) {
    return el('div', { class: `banner ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, [
      el('span', { class: 'banner-icon' }, [icon(BANNER_ICON[kind] ?? 'info', 18)]),
      el('div', { class: 'banner-body' }, [title && el('strong', { text: title }), ...[].concat(message).map((m) => (typeof m === 'string' ? el('p', { text: m }) : m))]),
      actions.length ? el('div', { class: 'banner-actions' }, actions) : null,
    ]);
  }

  const empty = (title, text, action) => el('div', { class: 'empty-state' }, [
    el('span', { class: 'empty-icon' }, [icon('file', 20)]), el('strong', { text: title }), text && el('p', { text }), action,
  ]);

  // Placeholder shapes while a page loads: 'cards', 'table' or 'block'.
  function skeleton(kind = 'table', count = 4) {
    if (kind === 'cards') return el('div', { class: 'metrics', 'aria-hidden': 'true' }, Array.from({ length: count }, () => el('div', { class: 'card skeleton-card' }, [el('div', { class: 'sk sk-line short' }), el('div', { class: 'sk sk-line big' })])));
    if (kind === 'block') return el('div', { class: 'card', 'aria-hidden': 'true' }, [el('div', { class: 'sk sk-line short' }), el('div', { class: 'sk sk-block' })]);
    return el('div', { class: 'card', 'aria-hidden': 'true' }, [el('div', { class: 'sk sk-line short' }), ...Array.from({ length: count }, () => el('div', { class: 'sk sk-row' }))]);
  }
  const loading = (label = 'Loading') => el('div', { class: 'loading-region', role: 'status', 'aria-live': 'polite' }, [el('span', { class: 'visually-hidden', text: `${label}…` })]);

  function pill(text, kind = '') { return el('span', { class: `pill ${kind}`.trim(), text }); }

  function field({ label, control, hint, error, className = '' }) {
    const id = control.id || (control.id = uid('f'));
    const hintId = hint ? `${id}-hint` : null;
    const errorId = `${id}-error`;
    control.setAttribute('aria-describedby', [hintId, errorId].filter(Boolean).join(' '));
    const errorNode = el('p', { class: 'field-error', id: errorId, text: error ?? '' });
    if (error) control.setAttribute('aria-invalid', 'true');
    return el('div', { class: `field ${className}`.trim() }, [el('label', { for: id, text: label }), control, hint && el('p', { class: 'field-hint', id: hintId, text: hint }), errorNode]);
  }
  function setFieldError(control, message) {
    const node = document.getElementById(`${control.id}-error`);
    if (node) node.textContent = message ?? '';
    if (message) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid');
  }

  function table({ columns, rows, className = '', rowAttrs, caption }) {
    return el('div', { class: 'table-wrap' }, [el('table', { class: className }, [
      caption && el('caption', { class: 'visually-hidden', text: caption }),
      el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { scope: 'col', class: c.className, text: c.label })))]),
      el('tbody', {}, rows.map((r) => el('tr', rowAttrs?.(r) ?? {}, columns.map((c) => el('td', { class: c.className, 'data-label': c.label || null }, [c.render(r)]))))),
    ])]);
  }

  function toast(message, kind = 'success') {
    const region = document.getElementById('toasts');
    if (!region) return;
    const node = el('div', { class: `toast ${kind}` }, [icon(BANNER_ICON[kind] ?? 'check', 16), el('span', { text: message })]);
    region.append(node);
    setTimeout(() => { node.classList.add('leaving'); setTimeout(() => node.remove(), 250); }, 4500);
  }

  // A modal <dialog>: Escape and Cancel close it; resolves once closed.
  function modal({ title, description, content = [], actions = [], wide = false, onClose }) {
    const titleId = uid('dlg');
    const dialog = el('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-labelledby': titleId }, [
      el('div', { class: 'modal-header' }, [el('h2', { id: titleId, text: title }), description && el('p', { text: description })]),
      el('div', { class: 'modal-body' }, content),
      el('div', { class: 'modal-footer' }, actions),
    ]);
    document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); onClose?.(); });
    dialog.showModal();
    return dialog;
  }

  // Resolves true only on the confirm button. acknowledge: a checkbox label the admin must tick before confirming.
  function confirm({ title, body = [], confirmText = 'Confirm', danger = false, warning, acknowledge }) {
    return new Promise((resolve) => {
      let confirmed = false;
      const ok = button(confirmText, { kind: danger ? 'danger-solid' : 'primary' });
      const cancel = button('Cancel');
      const content = [].concat(body).map((b) => (typeof b === 'string' ? el('p', { text: b }) : b));
      let check = null;
      if (warning) content.push(banner('warning', warning));
      if (acknowledge) {
        check = el('input', { type: 'checkbox', id: uid('ack') });
        content.push(el('label', { class: 'ack', for: check.id }, [check, el('span', { text: acknowledge })]));
        ok.disabled = true;
        check.addEventListener('change', () => { ok.disabled = !check.checked; });
      }
      const dialog = modal({ title, content, actions: [cancel, ok], onClose: () => resolve(confirmed) });
      cancel.addEventListener('click', () => dialog.close());
      ok.addEventListener('click', () => { confirmed = true; dialog.close(); });
      (check ?? (danger ? cancel : ok)).focus();
    });
  }

  function download(name, text, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a', { href: url, download: name, class: 'visually-hidden' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Reads shared by several pages (/api/me, /api/capabilities, /api/roles) are cached until invalidated.
  const cache = new Map();
  function shared(path, { fresh = false } = {}) {
    if (fresh || !cache.has(path)) {
      const pending = api.get(path);
      pending.catch(() => cache.delete(path));
      cache.set(path, pending);
    }
    return cache.get(path);
  }
  const invalidate = (path) => cache.delete(path);
  // Settles to the value or to the Error, so a page can show what loaded and explain what did not.
  const settle = (promise) => promise.then((value) => value, (error) => (error instanceof Error ? error : new Error(String(error))));

  const settingsLink = (text = 'Open Settings') => el('a', { href: '#/settings', class: 'inline-link' }, [text, icon('arrow', 14)]);

  return { uid, icon, button, busy, pageHeader, card, banner, empty, skeleton, loading, pill, field, setFieldError, table, toast, modal, confirm, download, shared, invalidate, settle, settingsLink };
})();
