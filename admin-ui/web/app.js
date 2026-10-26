// The admin-ui frontend's router and shell, and its Dashboard and Budgets pages: a hash-routed SPA in vanilla JS (no
// build step, no framework - admin-ui/server.mjs serves this directory as-is). ui.js and the other pages' scripts load
// before this one. Every number shown comes from a real API response; nothing here is sample data.
const links = document.querySelectorAll('nav a[data-route]');
const PERIOD_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const centsOf = (amount) => (amount === null || amount === undefined ? null : Number(amount));

function usageMeter(spendCents, capCents) {
  if (capCents === null || capCents <= 0) return el('span', { class: 'muted', text: '—' });
  const pct = Math.min(100, Math.round((spendCents / capCents) * 100));
  const fill = el('span', { class: 'meter-fill' });
  fill.style.setProperty('--pct', `${pct}%`);
  return el('div', { class: `usage${pct >= 90 ? ' high' : pct >= 75 ? ' warn' : ''}` }, [
    el('span', { class: 'meter', role: 'img', 'aria-label': `${pct}% of the cap used` }, [fill]), el('span', { class: 'usage-pct', text: `${pct}%` }),
  ]);
}

const capSourceText = (source) => source.replace(/^rbac_group: /, 'Role ').replace(/^user$/, 'User cap').replace(/^organization$/, 'Organization');

// ---------- Dashboard ----------
async function renderDashboard(ctx) {
  ctx.root.replaceChildren(
    ui.pageHeader({ title: 'Dashboard', description: 'Spend the gateway has recorded this month, and the latest changes to spend caps.' }),
    ui.skeleton('cards', 3), ui.skeleton('table', 5), ui.loading('Loading the dashboard'));
  const [limits, effective, audit, config] = await Promise.all([
    ui.settle(api.get('/api/spend-limits')),
    ui.settle(api.get('/api/spend-limits/effective?period[]=monthly&sort=spend_desc&limit=100')),
    ui.settle(api.get('/api/spend-limits/audit?limit=5')),
    ui.settle(ui.shared('/api/gateway-config')),
  ]);
  if (!ctx.active()) return;
  const spenders = effective instanceof Error ? [] : (effective.data ?? []).map((r) => spendView.spendRow(r));
  const totalCents = spenders.reduce((sum, view) => sum + view.spendCents, 0);
  const caps = limits instanceof Error ? null : (limits.data ?? []);
  const events = audit instanceof Error ? [] : (audit.data ?? []);
  const names = spendView.userNames(effective instanceof Error ? [] : effective.data);
  const last = events.length ? spendView.auditChange(events[0], names) : null;
  const metric = (label, iconName, value, sub) => el('div', { class: 'card metric-card' }, [
    el('div', { class: 'metric-label' }, [el('span', { class: 'metric-icon' }, [ui.icon(iconName, 16)]), label]),
    el('div', { class: 'metric-value', text: value }), el('div', { class: 'metric-sub', text: sub }),
  ]);
  const withSpend = spenders.filter((view) => view.spendCents > 0).length;
  ctx.root.replaceChildren(
    ui.pageHeader({ title: 'Dashboard', description: 'Spend the gateway has recorded this month, and the latest changes to spend caps.' }),
    el('div', { class: 'metrics' }, [
      metric('Spend this month', 'trend', effective instanceof Error ? '—' : spendView.usd(totalCents),
        effective instanceof Error ? 'Could not load spend' : `${withSpend} ${withSpend === 1 ? 'user' : 'users'} with spend${effective.next_page ? ' · first 100 users' : ''}`),
      metric('Spend caps', 'gauge', caps ? String(caps.length) : '—',
        caps ? spendView.capBreakdown(caps) : 'Could not load caps'),
      metric('Last cap change', 'history', last ? last.when.slice(0, 10) : '—', last ? `${last.action} · ${last.scope} · ${last.actor}` : 'No changes recorded'),
    ]),
    ui.card({
      title: 'Top spenders this month', description: 'Highest spend first, as the gateway reports it.',
      actions: [el('a', { href: '#/chargeback', class: 'btn ghost sm' }, [el('span', { text: 'Chargeback' }), ui.icon('arrow', 14)])],
      content: effective instanceof Error ? ui.banner('error', `Could not load spend: ${effective.message}`)
        : spenders.length ? spendersTable(spenders.slice(0, 5)) : ui.empty('No spend recorded this month', 'Spend appears after developers send requests through the gateway.'),
    }),
    el('div', { class: 'grid-2' }, [recentChangesCard(audit, names), gatewayCard(config)]),
  );
}

function spendersTable(views) {
  return ui.table({
    caption: 'Top spenders this month',
    columns: [
      { label: 'Developer', render: (view) => el('div', { class: 'who' }, [el('strong', { text: view.name }), view.email && el('span', { text: view.email })]) },
      { label: 'Spend', className: 'num', render: (view) => spendView.usd(view.spendCents, 4) },
      { label: 'Cap', className: 'num', render: (view) => spendView.usd(view.capCents) },
      { label: 'Used', className: 'usage-col', render: (view) => usageMeter(view.spendCents, view.capCents) },
      { label: 'Cap set by', render: (view) => capSourceText(view.capSource) },
      { label: 'Roles', render: (view) => view.groups },
    ],
    rows: views,
  });
}

function recentChangesCard(audit, names) {
  const link = el('a', { href: '#/audit', class: 'btn ghost sm' }, [el('span', { text: 'Audit' }), ui.icon('arrow', 14)]);
  if (audit instanceof Error) return ui.card({ title: 'Recent cap changes', actions: [link], content: ui.banner('error', `Could not load the audit trail: ${audit.message}`) });
  const events = (audit.data ?? []).map((e) => spendView.auditChange(e, names));
  return ui.card({
    title: 'Recent cap changes', actions: [link],
    content: events.length ? el('ul', { class: 'feed' }, events.map((c) => el('li', {}, [
      ui.pill(c.action, c.action === 'Removed' ? 'danger' : c.action === 'Created' ? 'ok' : 'info'),
      el('div', {}, [el('strong', { text: `${c.scope} · ${PERIOD_LABEL[c.period] ?? c.period}` }), el('span', { class: 'muted', text: `${c.before} → ${c.after}` })]),
      el('span', { class: 'feed-meta', text: `${c.when} · ${c.actor}` }),
    ]))) : ui.empty('No changes recorded', 'Changes to spend caps appear here.'),
  });
}

function gatewayCard(config) {
  const link = el('a', { href: '#/access', class: 'btn ghost sm' }, [el('span', { text: 'Access & models' }), ui.icon('arrow', 14)]);
  if (config instanceof Error) return ui.card({ title: 'Gateway configuration', actions: [link], content: ui.banner('info', `Not available: ${config.message}`) });
  const admin = config.admin ?? {};
  const row = (label, value) => [el('dt', { text: label }), el('dd', {}, [value])];
  const chips = (values) => (values.length ? el('div', { class: 'chips' }, values.map((v) => el('code', { text: v }))) : el('span', { class: 'muted', text: 'None' }));
  const temporary = config.restart?.temporaryDatabase === true;
  return ui.card({
    title: 'Gateway configuration', actions: [link],
    content: [
      el('dl', { class: 'facts' }, [
        ...row('Admitted roles', chips(admin.roles ?? [])),
        ...row('Models', chips((admin.models ?? []).map((m) => m.id))),
        ...row('Gateway app', el('code', { text: config.gateway?.app ?? 'unknown' })),
        ...row('Latest revision', el('code', { text: config.gateway?.revision ?? 'unknown' })),
        ...row('Database', temporary ? ui.pill('Temporary', 'warn') : ui.pill('Persistent', 'ok')),
        ...row('Deployed admin file', config.deployFileMatches === false ? ui.pill('Differs from the live configuration', 'warn') : ui.pill('Matches the live configuration', 'ok')),
      ]),
      temporary ? el('p', { class: 'note warn' }, [ui.icon('warning', 14), el('span', { text: 'Each new revision starts with an empty database: spend totals, caps and the audit trail reset.' })]) : null,
    ].filter(Boolean),
  });
}

// ---------- Budgets ----------
async function renderBudgets(ctx) {
  const capsBody = el('div', {}, [ui.skeleton('table', 3)]);
  const fileSlot = el('div');
  const form = budgetForm(() => refresh());
  ctx.root.replaceChildren(
    ui.pageHeader({ title: 'Budgets', description: 'Spend caps the gateway enforces for a user, a role or the whole organization. A change applies immediately.' }),
    form.node,
    ui.card({ title: 'Configured caps', description: 'The caps the gateway enforces now. Without a cap, spend is unlimited.', content: capsBody, className: 'flush' }),
    fileSlot);
  const [roles, config, effective] = await Promise.all([
    ui.settle(ui.shared('/api/roles')), ui.settle(ui.shared('/api/gateway-config')),
    ui.settle(api.get('/api/spend-limits/effective?period[]=monthly&limit=1000')),
  ]);
  if (!ctx.active()) return;
  form.setRoles(rolesView.choices(roles instanceof Error ? null : roles, config instanceof Error ? null : config.admin));
  const people = new Map((effective instanceof Error ? [] : effective.data ?? []).map((r) => [r.scope?.user_id, spendView.spendRow(r)]));

  async function refresh() {
    const result = await ui.settle(api.get('/api/spend-limits'));
    if (!ctx.active()) return;
    if (result instanceof Error) { capsBody.replaceChildren(ui.banner('error', `Could not load spend caps: ${result.message}`)); return; }
    const caps = result.data ?? [];
    capsBody.replaceChildren(caps.length ? capsTable(caps, people, refresh) : ui.empty('No caps configured', 'Set one above.'));
    fileSlot.replaceChildren(...fileBudgetsCard(config, caps, refresh));
  }
  await refresh();
}

function scopeCell(scope, people) {
  if (!scope || scope.type === 'organization') return el('div', { class: 'scope' }, [ui.pill('Organization', 'accent')]);
  if (scope.type === 'rbac_group') return el('div', { class: 'scope' }, [ui.pill('Role', 'info'), el('code', { text: scope.rbac_group_id })]);
  const person = people?.get(scope.user_id);
  return el('div', { class: 'scope' }, [ui.pill('User', ''), person
    ? el('div', { class: 'who', title: scope.user_id }, [el('strong', { text: person.name }), person.email && el('span', { text: person.email })])
    : el('code', { text: scope.user_id })]);
}

function capsTable(caps, people, refresh) {
  const order = { organization: 0, rbac_group: 1, user: 2 };
  const sorted = [...caps].sort((a, b) => (order[a.scope?.type] ?? 3) - (order[b.scope?.type] ?? 3));
  const names = new Map([...(people ?? [])].map(([id, person]) => [id, person.name]));
  return ui.table({
    caption: 'Configured caps',
    columns: [
      { label: 'Scope', render: (cap) => scopeCell(cap.scope, people) },
      { label: 'Amount', className: 'num', render: (cap) => spendView.usd(centsOf(cap.amount)) },
      { label: 'Period', render: (cap) => PERIOD_LABEL[cap.period] ?? cap.period },
      { label: '', className: 'actions', render: (cap) => ui.button('Remove', { kind: 'danger', size: 'sm', iconName: 'trash', 'aria-label': `Remove the ${spendView.scopeText(cap.scope, names)} cap`, onclick: () => removeCap(cap, refresh, names) }) },
    ],
    rows: sorted,
  });
}

async function removeCap(cap, refresh, names) {
  const what = `${spendView.scopeText(cap.scope, names)} · ${spendView.usd(centsOf(cap.amount))} ${(PERIOD_LABEL[cap.period] ?? cap.period).toLowerCase()}`;
  const ok = await ui.confirm({ title: 'Remove this cap?', body: [what, 'The gateway stops enforcing it immediately.'], confirmText: 'Remove cap', danger: true });
  if (!ok) return;
  try {
    await api.del(`/api/spend-limits/${encodeURIComponent(cap.id)}`);
    ui.toast(`Removed the cap: ${what}`);
  } catch (err) {
    ui.toast(`Could not remove the cap: ${err.message}`, 'error');
  }
  await refresh();
}

function budgetForm(onSaved) {
  const option = (value, text, selected = false) => el('option', { value, text, selected });
  const scope = el('select', { name: 'scope' }, [option('user', 'User'), option('rbac_group', 'Role'), option('organization', 'Organization')]);
  const user = el('input', { name: 'user', placeholder: 'e.g. dev@contoso.com', autocomplete: 'off', spellcheck: 'false' });
  let role = el('select', { name: 'role', disabled: true }, [option('', 'Loading roles…')]);
  const amount = el('input', { name: 'amount', inputmode: 'decimal', placeholder: 'Unlimited', autocomplete: 'off' });
  const period = el('select', { name: 'period' }, [option('monthly', 'Monthly', true), option('weekly', 'Weekly'), option('daily', 'Daily')]);
  const submit = ui.button('Set cap', { kind: 'primary', type: 'submit', iconName: 'check' });
  const userField = ui.field({ label: 'User', control: user, hint: 'E-mail address or OIDC subject. An address resolves after the user’s first request through the gateway.', className: 'wide' });
  const roleField = ui.field({ label: 'Role', control: role, hint: 'An admitted gateway role.', className: 'wide' });
  const orgField = el('div', { class: 'field wide' }, [el('span', { class: 'field-label', text: 'Applies to' }), el('p', { class: 'field-static', text: 'Everyone who uses the gateway' })]);
  const status = el('div', { class: 'form-status' });
  const sync = () => { userField.hidden = scope.value !== 'user'; roleField.hidden = scope.value !== 'rbac_group'; orgField.hidden = scope.value !== 'organization'; };
  scope.addEventListener('change', sync);
  sync();
  const form = el('form', { class: 'form-grid', novalidate: true }, [
    ui.field({ label: 'Scope', control: scope }), userField, roleField, orgField,
    ui.field({ label: 'Amount (USD)', control: amount, hint: 'Blank means unlimited.' }),
    ui.field({ label: 'Period', control: period }),
    el('div', { class: 'form-actions' }, [submit]),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.replaceChildren();
    for (const c of [user, role, amount]) ui.setFieldError(c, '');
    const amountText = amount.value.trim().replace(/^\$/, '').replace(/,/g, '');
    if (amountText && !/^\d+(\.\d{1,2})?$/.test(amountText)) { ui.setFieldError(amount, 'Enter dollars, like 500 or 500.00, or leave it blank.'); amount.focus(); return; }
    const amountCents = amountText === '' ? null : Math.round(Number(amountText) * 100);
    ui.busy(submit, true, 'Setting…');
    try {
      let target;
      if (scope.value === 'organization') target = { type: 'organization' };
      else if (scope.value === 'rbac_group') {
        if (!role.value.trim()) { ui.setFieldError(role, 'Choose a role.'); role.focus(); return; }
        target = { type: 'rbac_group', rbac_group_id: role.value.trim() };
      } else {
        const value = user.value.trim();
        const found = value.includes('@') ? (await api.get(`/api/spend-limits/effective?period[]=monthly&limit=1000&q=${encodeURIComponent(value)}`)).data : [];
        try { target = { type: 'user', user_id: spendView.resolveUserTarget(value, found) }; } catch (err) { ui.setFieldError(user, err.message); user.focus(); return; }
      }
      await api.post('/api/spend-limits', { scope: target, amountCents, period: period.value });
      ui.toast(`Cap set: ${spendView.scopeText(target)} · ${spendView.usd(amountCents)} ${period.value}`);
      user.value = ''; amount.value = '';
      await onSaved();
    } catch (err) {
      status.replaceChildren(ui.banner('error', `Could not set the cap: ${err.message}`));
    } finally {
      ui.busy(submit, false);
    }
  });
  const node = ui.card({ title: 'Set a cap', description: 'Setting a cap for a scope and period that already has one replaces it.', content: [status, form] });
  return {
    node,
    // Role choices: the admitted roles; null (neither Entra nor the admin file readable) falls back to free text.
    setRoles(choices) {
      const next = choices
        ? el('select', { name: 'role', id: role.id, 'aria-describedby': role.getAttribute('aria-describedby') }, choices.length
          ? choices.map((c) => option(c.value, c.label ? `${c.value} — ${c.label}` : c.value)) : [option('', 'No admitted roles')])
        : el('input', { name: 'role', id: role.id, placeholder: 'e.g. Gateway.Standard', 'aria-describedby': role.getAttribute('aria-describedby') });
      role.replaceWith(next);
      role = next;
    },
  };
}

function fileBudgetsCard(config, caps, refresh) {
  if (config instanceof Error || !config?.admin?.budgets?.length) return [];
  const items = spendView.fileBudgets(config.admin.budgets, caps);
  const pending = items.filter((i) => i.status !== 'set');
  const set = async (list, btn) => {
    if (btn) ui.busy(btn, true, 'Setting…');
    try {
      for (const item of list) await api.post('/api/spend-limits', item.body);
      ui.toast(list.length === 1 ? `Cap set: ${list[0].scope}` : `${list.length} caps set`);
    } catch (err) {
      ui.toast(`Could not set the cap: ${err.message}`, 'error');
    }
    await refresh();
  };
  const status = { set: ['Enforced', 'ok'], differs: ['Different amount', 'warn'], missing: ['Not set', 'danger'] };
  const description = config.restart?.temporaryDatabase
    ? `This gateway keeps its database on temporary storage, so a new revision starts without caps. These are the caps ${configView.downloadName(config.adminFilePath)} lists.`
    : `The caps ${configView.downloadName(config.adminFilePath)} lists, compared with what the gateway enforces now.`;
  const all = pending.length > 1 ? ui.button(`Set the ${pending.length} caps`, { kind: 'secondary', size: 'sm', onclick: (e) => set(pending, e.currentTarget) }) : null;
  return [ui.card({
    title: 'Caps in the admin file', description, actions: [all].filter(Boolean), className: 'flush',
    content: ui.table({
      caption: 'Caps in the admin file',
      columns: [
        { label: 'Scope', render: (i) => i.scope },
        { label: 'Period', render: (i) => PERIOD_LABEL[i.period] ?? i.period },
        { label: 'In the file', className: 'num', render: (i) => i.amount },
        { label: 'Enforced now', className: 'num', render: (i) => i.live },
        { label: 'Status', render: (i) => ui.pill(...status[i.status]) },
        { label: '', className: 'actions', render: (i) => (i.status === 'set' ? '' : ui.button(i.status === 'missing' ? 'Set' : 'Set again', { kind: 'secondary', size: 'sm', onclick: (e) => set([i], e.currentTarget) })) },
      ],
      rows: items,
    }),
  })];
}

// ---------- Shell: identity, router ----------
async function renderIdentity() {
  const box = document.getElementById('identity');
  if (!box) return;
  const me = await ui.settle(ui.shared('/api/me'));
  const id = settingsView.identity(me instanceof Error ? null : me);
  box.dataset.mode = id.mode;
  box.setAttribute('aria-label', `${id.text}. Open Settings`);
  box.replaceChildren(
    id.mode === 'user' ? el('span', { class: 'avatar', 'aria-hidden': 'true', text: id.initials }) : el('span', { class: 'avatar icon-only', 'aria-hidden': 'true' }, [ui.icon(id.mode === 'off' ? 'shield' : 'lock', 15)]),
    el('span', { class: 'identity-text' }, id.mode === 'off'
      ? [el('span', { class: 'identity-note', text: id.text })]
      : [el('strong', { text: id.title }), id.subtitle && el('span', { text: id.subtitle })]),
    id.badge && ui.pill(id.badge, id.admin ? 'ok' : ''),
  );
}

const pages = {
  dashboard: { title: 'Dashboard', render: renderDashboard },
  budgets: { title: 'Budgets', render: renderBudgets },
  chargeback: chargebackPage,
  developers: developersPage,
  roles: rolesPage,
  access: accessPage,
  audit: auditPage,
  settings: settingsPage,
  help: helpPage,
};
let current = null;

async function onRouteChange() {
  const hash = location.hash || '#/dashboard';
  if (current && current.hash === hash) return;
  const message = current?.guard?.();
  if (message && !(await ui.confirm({ title: 'Leave this page?', body: [message], confirmText: 'Discard changes', danger: true }))) {
    history.replaceState(null, '', current.hash);
    return;
  }
  if (current) { current.active = false; for (const fn of current.cleanups) fn(); }
  const [name, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const route = pages[name] ? name : 'dashboard';
  const me = { hash, active: true, cleanups: [], guard: null };
  current = me;
  for (const link of links) {
    link.classList.toggle('active', link.dataset.route === route);
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  document.title = `${pages[route].title} · Claude apps gateway - Foundry`;
  const ctx = {
    root: app, query: new URLSearchParams(query), active: () => current === me && me.active,
    onLeave: (fn) => me.cleanups.push(fn), setGuard: (fn) => { me.guard = fn; },
    replaceHash: (next) => { history.replaceState(null, '', next); me.hash = next; },
  };
  try {
    const rendering = pages[route].render(ctx);
    if (app.dataset.started) { window.scrollTo(0, 0); app.focus({ preventScroll: true }); }
    app.dataset.started = 'true';
    await rendering;
  } catch (err) {
    console.error(err);
    if (ctx.active()) app.replaceChildren(...[app.querySelector('.page-header')].filter(Boolean), ui.banner('error', `This page could not be shown: ${err.message}`));
  }
}

function renderAccessDenied(access) {
  document.title = 'No access · Claude apps gateway - Foundry';
  document.querySelector('nav')?.setAttribute('hidden', '');
  app.replaceChildren(
    ui.pageHeader({ title: access.title }),
    ui.card({ title: 'AdminUi.Admin is required', content: access.body.map((line) => el('p', { text: line })) }),
  );
}

// ADR-0011: the access check runs before routing, so a signed-in non-admin never loads a page.
async function start() {
  const me = await ui.settle(ui.shared('/api/me'));
  const access = settingsView.accessDenied(me instanceof Error ? null : me);
  renderIdentity();
  if (access.denied) { renderAccessDenied(access); return; }
  window.addEventListener('beforeunload', (event) => { if (current?.guard?.()) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('hashchange', onRouteChange);
  onRouteChange();
}
start();
