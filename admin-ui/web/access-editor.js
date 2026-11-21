// Builders for the Access & models editor: the role × model matrix, the admitted roles, the models list and the
// add/edit model dialog. They draw the draft admin file and report every edit through callbacks; access-page.js owns
// the state and the flow. Edits themselves are configView's (config-view.js), so they are unit-tested.
const accessEditor = (() => {
  const cv = () => configView;
  const list = (v) => (Array.isArray(v) ? v : []);
  const names = (roles) => new Map(list(roles?.roles).map((r) => [r.value, r.displayName]));

  // The gateway applies the first policy that matches a developer's roles, so rows follow the policies' order.
  function orderedRoles(admin) {
    const roles = list(admin.roles);
    if (!Array.isArray(admin.policies)) return roles;
    const byPolicy = admin.policies.map((p) => p.role).filter((r) => roles.includes(r));
    return [...new Set([...byPolicy, ...roles])];
  }

  function arrowKeys(table) {
    const moves = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    table.addEventListener('keydown', (event) => {
      const move = moves[event.key];
      const from = event.target.closest?.('[data-row]');
      if (!move || !from) return;
      const target = table.querySelector(`[data-row="${Number(from.dataset.row) + move[0]}"][data-col="${Number(from.dataset.col) + move[1]}"]`);
      if (target) { event.preventDefault(); target.focus(); }
    });
  }

  // s: { draft, original, readOnly, roles, flagged: { role: Set, model: Set } }; act: the page's edit callbacks.
  function matrix(s, act) {
    const models = list(s.draft.models);
    const display = names(s.roles);
    const problems = new Map(cv().problems(s.draft).map((p) => [p.role, p.message]));
    const roles = orderedRoles(s.draft);
    const changed = new Set(cv().changedCells(s.original, s.draft));
    const mark = (key) => (changed.has(key) ? { class: 'cell changed', title: 'Changed, not applied yet' } : { class: 'cell' });
    const edited = (key) => (changed.has(key) ? ', changed' : '');
    const table = el('table', { class: 'matrix' }, [
      el('caption', { class: 'visually-hidden', text: 'Models and Claude Desktop per admitted role. Arrow keys move between cells.' }),
      el('thead', {}, [el('tr', {}, [
        el('th', { scope: 'col', class: 'role-col', text: 'Role' }),
        ...models.map((m) => el('th', { scope: 'col', class: 'cell-col' }, [el('span', { class: 'col-title', text: m.label || m.id }), el('code', { text: m.id })])),
        el('th', { scope: 'col', class: 'cell-col desktop-col' }, [el('span', { class: 'col-title', text: 'Claude Desktop' }), el('span', { class: 'col-sub', text: 'incl. Cowork' })]),
      ])]),
      el('tbody', {}, roles.map((role, r) => {
        const allowed = new Set(cv().allowedModels(s.draft, role));
        const problem = problems.get(role);
        const problemId = problem ? ui.uid('problem') : null;
        return el('tr', { class: s.flagged.role.has(role) ? 'row-problem' : problem ? 'row-warn' : null, 'data-role': role }, [
          el('th', { scope: 'row', class: 'role-col' }, [
            el('div', { class: 'role-head' }, [
              roles.length > 1 ? el('span', { class: 'order', title: 'Order: the first matching role applies', text: String(r + 1) }) : null,
              el('div', { class: 'who' }, [el('code', { class: 'strong', text: role }), display.get(role) && el('span', { text: display.get(role) })]),
              changed.has(`row|${role}`) ? ui.pill('New', 'accent') : null,
            ]),
            problem && el('p', { class: 'cell-problem', id: problemId, text: 'Tick at least one model.' }),
          ]),
          ...models.map((m, c) => el('td', mark(`model|${role}|${m.id}`), [el('input', {
            type: 'checkbox', class: 'check', checked: allowed.has(m.id), disabled: Boolean(s.readOnly),
            'aria-label': `${role}: ${m.label || m.id}${edited(`model|${role}|${m.id}`)}`, 'aria-describedby': problemId,
            'data-key': `model|${role}|${m.id}`, 'data-row': r, 'data-col': c,
            onchange: (e) => act.toggleModel(role, m.id, e.currentTarget.checked),
          })])),
          el('td', mark(`desktop|${role}`), [el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox', role: 'switch', checked: cv().desktopOf(s.draft, role), disabled: Boolean(s.readOnly),
              'aria-label': `${role}: Claude Desktop, including Cowork${edited(`desktop|${role}`)}`, 'data-key': `desktop|${role}`, 'data-row': r, 'data-col': models.length,
              onchange: (e) => act.setDesktop(role, e.currentTarget.checked),
            }),
            el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
          ])]),
        ]);
      })),
    ]);
    arrowKeys(table);
    const noPolicies = !Array.isArray(s.draft.policies);
    return ui.card({
      title: 'Role access', className: 'flush',
      description: 'Terminal, VS Code and JetBrains are always allowed together for an admitted role (the gateway’s cli access), limited to the models ticked here. Claude Desktop, including Cowork, is a separate switch per role.',
      content: [
        noPolicies ? el('div', { class: 'card-body' }, [ui.banner('info', 'The admin file has no per-role policies: every admitted role can use every model, and Claude Desktop is off. The first change here writes a policy for each role.')]) : null,
        roles.length ? el('div', { class: 'table-wrap' }, [table]) : ui.empty('No admitted roles', 'Admit a role below.'),
        roles.length > 1 ? el('p', { class: 'card-foot' }, [ui.icon('info', 14), el('span', { text: 'A developer with several roles gets the access of the first matching row.' })]) : null,
      ],
    });
  }

  function admission(s, act) {
    const entra = list(s.roles?.roles);
    const known = new Set(entra.map((r) => r.value));
    const orphans = [...new Set([...list(s.original.roles), ...list(s.draft.roles)])].filter((r) => !known.has(r));
    const entries = [
      ...entra.map((r) => ({ value: r.value, displayName: r.displayName, description: r.description, enabled: r.isEnabled !== false, inEntra: true })),
      ...orphans.map((value) => ({ value, enabled: true, inEntra: false })),
    ];
    const rows = entries.map((entry) => {
      const admitted = list(s.draft.roles).includes(entry.value);
      const changed = admitted !== list(s.original.roles).includes(entry.value);
      let reason = null;
      if (admitted) reason = cv().unadmitBlocker(s.draft, entry.value);
      else if (!entry.enabled) reason = 'Disabled in Entra ID. Enable it there to admit it.';
      if (!entry.inEntra) reason = [reason, 'Not found among the app registration’s roles in Entra ID.'].filter(Boolean).join(' ');
      const reasonId = reason ? ui.uid('reason') : null;
      const locked = Boolean(s.readOnly) || (admitted ? Boolean(cv().unadmitBlocker(s.draft, entry.value)) : !entry.enabled);
      return el('li', { class: `admit-row${admitted ? ' on' : ''}` }, [
        el('label', { class: 'switch' }, [
          el('input', {
            type: 'checkbox', role: 'switch', checked: admitted, disabled: locked, 'aria-describedby': reasonId,
            'aria-label': `Admit ${entry.value}`, 'data-key': `admit|${entry.value}`,
            onchange: (e) => (e.currentTarget.checked ? act.admit(entry.value) : act.unadmit(entry.value)),
          }),
          el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        ]),
        el('div', { class: 'admit-main' }, [
          el('div', { class: 'admit-title' }, [
            el('code', { class: 'strong', text: entry.value }), entry.displayName && el('span', { text: entry.displayName }),
            changed ? ui.pill(admitted ? 'Admitting' : 'Removing', 'accent') : null,
            entry.enabled ? null : ui.pill('Disabled in Entra', 'danger'),
          ]),
          entry.description && el('p', { class: 'muted', text: entry.description }),
          reason && el('p', { class: 'reason', id: reasonId, text: reason }),
        ]),
      ]);
    });
    return ui.card({
      title: 'Admitted roles', description: 'An admitted role gets a row in Role access above. Admitting one needs at least one model ticked for it.',
      actions: [el('a', { class: 'btn ghost sm', href: '#/roles' }, [el('span', { text: 'Roles' }), ui.icon('arrow', 14)])],
      content: [
        s.roles instanceof Error ? el('div', { class: 'card-body' }, [ui.banner('warning', `Could not list the Entra app roles (${s.roles.message}). Only the roles the admin file admits are shown.`)]) : null,
        el('ul', { class: 'admit-list' }, rows),
      ],
    });
  }

  function desktop(s, act) {
    const roles = orderedRoles(s.draft).filter((role) => cv().desktopOf(s.draft, role));
    return ui.card({
      title: 'Desktop capabilities',
      description: 'Per-role controls delivered at Desktop sign-in. Default leaves the setting unset; the Desktop default applies. Review and apply changes as usual.',
      content: [
        el('p', { class: 'card-body muted', text: 'Imports can contain sensitive conversations. Plugins and extensions can run programs on the device. Enabling these options does not install plugins or approve tool calls, and does not enable automatic migration of earlier sessions.' }),
        ...roles.map((role) => el('details', { class: 'card-body', open: true }, [
          el('summary', { text: role }),
          el('div', { class: 'form-grid' }, cv().desktopFields.map(([key, label]) => {
            const value = cv().desktopSettingOf(s.draft, role, key);
            const control = el('select', {
              disabled: Boolean(s.readOnly), 'data-key': `desktop-setting|${role}|${key}`,
              onchange: (event) => act.setDesktopSetting(role, key, event.currentTarget.value === 'default' ? null : event.currentTarget.value === 'true'),
            }, [['default', 'Desktop default (unset)'], ['true', 'Enabled'], ['false', 'Disabled']].map(([choice, text]) =>
              el('option', { value: choice, text, selected: choice === (value === null ? 'default' : String(value)) })));
            return ui.field({ label: `${role}: ${label}`, control });
          })),
          connectors(s, act, role),
          marketplaces(s, act, role),
          patterns(s, act, role),
          egress(s, act, role),
        ])),
        ...(!roles.length ? [ui.empty('No Desktop-enabled roles', 'Enable Claude Desktop in Role access to configure its capabilities.')] : []),
      ],
    });
  }

  function models(s, act) {
    const add = ui.button('Add model', { kind: 'secondary', size: 'sm', iconName: 'plus', disabled: Boolean(s.readOnly), 'data-key': 'add-model', onclick: () => modelDialog(s, null, act) });
    const whyIds = new Map(list(s.draft.models).map((m) => [m.id, ui.uid('why')]));
    const table = ui.table({
      caption: 'Models',
      columns: [
        { label: 'Model', render: (m) => el('div', { class: 'who' }, [el('strong', { text: m.label || m.id }), el('code', { text: m.id })]) },
        { label: 'Foundry deployment', render: (m) => el('code', { text: m.deployment }) },
        { label: 'Allowed for', className: 'wrap', render: (m) => {
          const users = cv().modelUsers(s.draft, m.id);
          const blocker = cv().modelRemovalBlocker(s.draft, m.id);
          return el('div', { class: 'stack-xs' }, [
            users.length ? el('div', { class: 'pills' }, users.map((r) => ui.pill(r, 'info'))) : el('span', { class: 'muted', text: Array.isArray(s.draft.policies) ? 'No role' : 'Every admitted role' }),
            blocker && el('p', { class: 'reason', id: whyIds.get(m.id), text: blocker }),
          ]);
        } },
        { label: '', className: 'actions', render: (m) => el('div', { class: 'row-actions' }, [
          ui.button('Edit', { kind: 'ghost', size: 'sm', iconName: 'edit', disabled: Boolean(s.readOnly), 'aria-label': `Edit ${m.id}`, 'data-key': `edit|${m.id}`, onclick: () => modelDialog(s, m, act) }),
          ui.button('Remove', {
            kind: 'danger', size: 'sm', iconName: 'trash', 'aria-label': `Remove ${m.id}`, 'data-key': `remove|${m.id}`,
            disabled: Boolean(s.readOnly) || Boolean(cv().modelRemovalBlocker(s.draft, m.id)), 'aria-describedby': cv().modelRemovalBlocker(s.draft, m.id) ? whyIds.get(m.id) : null,
            onclick: () => act.removeModel(m.id),
          }),
        ]) },
      ],
      rows: list(s.draft.models),
      rowAttrs: (m) => ({ class: s.flagged.model.has(m.id) ? 'row-problem' : null }),
    });
    return ui.card({
      title: 'Models', className: 'flush', actions: [add],
      description: 'The model IDs developers select, and the Foundry deployment each one calls.',
      content: list(s.draft.models).length ? table : ui.empty('No models', 'Add the first model.'),
    });
  }

  function modelDialog(s, model, act) {
    const previousId = model?.id ?? null;
    const id = el('input', { name: 'id', value: model?.id ?? '', placeholder: 'e.g. claude-sonnet-5', autocomplete: 'off', spellcheck: 'false' });
    const label = el('input', { name: 'label', value: model?.label ?? '', placeholder: 'e.g. Claude Sonnet 5', autocomplete: 'off', maxlength: '100' });
    const deployment = el('input', { name: 'deployment', value: model?.deployment ?? '', placeholder: 'e.g. claude-sonnet-5', autocomplete: 'off', spellcheck: 'false' });
    const formId = ui.uid('model-form');
    const save = ui.button(model ? 'Save model' : 'Add model', { kind: 'primary', type: 'submit', form: formId });
    const cancel = ui.button('Cancel');
    const controls = { id, label, deployment };
    const form = el('form', { id: formId, class: 'stack', novalidate: true }, [
      ui.field({ label: 'Model ID', control: id, hint: 'The name developers select in Claude apps. Renaming it updates every role that allows it.' }),
      ui.field({ label: 'Label (optional)', control: label, hint: 'A readable name for this console.' }),
      ui.field({ label: 'Foundry deployment', control: deployment, hint: 'The deployment name in the Microsoft Foundry resource.' }),
    ]);
    const dialog = ui.modal({ title: model ? `Edit ${model.id}` : 'Add a model', description: 'Saved to your draft. Nothing changes on the gateway until you review and apply.', content: [form], actions: [cancel, save] });
    cancel.addEventListener('click', () => dialog.close());
    id.focus();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = { id: id.value, label: label.value, deployment: deployment.value };
      const errors = cv().modelErrors(s.draft, values, previousId);
      for (const [key, control] of Object.entries(controls)) ui.setFieldError(control, errors[key] ?? '');
      const first = Object.keys(errors)[0];
      if (first) { controls[first].focus(); return; }
      dialog.close();
      act.saveModel(values, previousId);
    });
  }

  // ADR-0014: the soft limit. On, the spend pacer job turns the rest of a person's monthly cap into a daily cap once
  // they pass this share of it. Off removes spendPacing from the draft.
  function softLimit(s, act) {
    const current = cv().softLimitOf(s.draft);
    const blocked = cv().softLimitError(s.draft, 80)?.includes('admin API') ? cv().softLimitError(s.draft, 80) : null;
    const reasonId = blocked ? ui.uid('soft') : null;
    const changed = cv().softLimitOf(s.original) !== current;
    const percent = el('input', {
      type: 'number', min: '1', max: '99', step: '1', inputmode: 'numeric', class: 'num-input', value: String(current ?? 80),
      disabled: Boolean(s.readOnly) || current === null, 'aria-label': 'Soft limit, percent of the monthly cap', 'data-key': 'soft-limit-percent',
      onchange: (e) => {
        const value = Number(e.currentTarget.value);
        const problem = cv().softLimitError(s.draft, value);
        ui.setFieldError(e.currentTarget, problem ?? '');
        if (!problem) act.setSoftLimit(value);
      },
    });
    return ui.card({
      title: 'Soft limit',
      description: 'Past this share of a person’s monthly spend cap, the rest of the cap is spread over the days left in the month: every five minutes the spend pacer sets that person a daily cap. Claude Code warns them at 75% and 95% of it, and the gateway’s refusal explains the daily limit.',
      content: el('div', { class: 'card-body stack' }, [
        el('div', { class: 'admit-row' }, [
          el('label', { class: 'switch' }, [
            el('input', {
              type: 'checkbox', role: 'switch', checked: current !== null, disabled: Boolean(s.readOnly) || Boolean(blocked),
              'aria-label': 'Soft limit', 'aria-describedby': reasonId, 'data-key': 'soft-limit',
              onchange: (e) => act.setSoftLimit(e.currentTarget.checked ? 80 : null),
            }),
            el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
          ]),
          el('div', { class: 'admit-main' }, [
            el('div', { class: 'admit-title' }, [el('strong', { text: current === null ? 'Off' : `${current}% of the monthly cap` }), changed ? ui.pill('Changed', 'accent') : null]),
            ui.field({ label: 'Percent of the monthly cap', control: percent }),
            blocked && el('p', { class: 'reason', id: reasonId, text: blocked }),
          ]),
        ]),
      ]),
    });
  }

  // ADR-0020: remote connectors (MCP servers) for the role. Headers, client secrets and local commands are not offered:
  // Desktop asks each user to approve those when a gateway delivers them, so they stay with device management.
  function connectors(s, act, role) {
    const items = cv().desktopListOf(s.draft, role, 'managedMcpServers');
    const ro = Boolean(s.readOnly);
    const name = el('input', { placeholder: 'e.g. Contoso Docs', 'aria-label': `${role}: connector name`, disabled: ro });
    const url = el('input', { placeholder: 'https://mcp.example.com/mcp', 'aria-label': `${role}: connector URL`, inputmode: 'url', disabled: ro });
    const transport = el('select', { 'aria-label': `${role}: connector transport`, disabled: ro }, [el('option', { value: 'http', text: 'Streamable HTTP' }), el('option', { value: 'sse', text: 'SSE (legacy)' })]);
    const signIn = el('select', { 'aria-label': `${role}: connector sign-in`, disabled: ro }, [el('option', { value: 'none', text: 'No sign-in' }), el('option', { value: 'oauth', text: 'OAuth (automatic registration)' }),
      el('option', { value: 'byo', text: 'OAuth with your client ID (no secret)' })]);
    const oauthClient = el('input', { placeholder: 'Client ID — e.g. Salesforce Consumer Key', 'aria-label': `${role}: connector OAuth client ID`, disabled: ro });
    const oauthScope = el('input', { placeholder: 'Scopes, e.g. mcp_api refresh_token', 'aria-label': `${role}: connector OAuth scopes`, disabled: ro });
    const problem = el('p', { class: 'cell-problem', role: 'alert' });
    const addEntries = (entries) => {
      const fresh = entries.filter((e) => !items.some((i) => i.name === e.name));
      if (!fresh.length) { problem.textContent = 'Already listed.'; return; }
      act.setDesktopList(role, 'managedMcpServers', [...items, ...fresh], `connector-add|${role}`);
    };
    const catalog = globalThis.desktopCatalog?.connectors ?? [];
    const pick = el('select', { 'aria-label': `${role}: connector from catalog`, disabled: ro }, [
      el('option', { value: '', text: 'Choose a connector…' }),
      ...catalog.filter((c) => !items.some((i) => i.name === c.entry.name)).map((c) => el('option', { value: c.entry.name, text: `${c.entry.name} — ${c.note}` })),
    ]);
    const addPick = ui.button('Add', { kind: 'secondary', size: 'sm', iconName: 'plus', disabled: ro, 'data-key': `connector-catalog|${role}`, onclick: () => {
      const found = catalog.find((c) => c.entry.name === pick.value);
      if (!found) { problem.textContent = 'Choose a connector from the list.'; return; }
      addEntries([cv().clone(found.entry)]);
    } });
    const addAll = ui.button('Add all catalog connectors', { kind: 'ghost', size: 'sm', disabled: ro, onclick: () => addEntries(catalog.map((c) => cv().clone(c.entry))) });
    const builtinKind = el('select', { 'aria-label': `${role}: built-in connector type`, disabled: ro }, [el('option', { value: 'microsoft365', text: 'Microsoft 365' }), el('option', { value: 'github', text: 'GitHub' })]);
    const tenant = el('input', { placeholder: 'Directory (tenant) ID — Microsoft 365 only', 'aria-label': `${role}: Microsoft 365 tenant ID`, disabled: ro });
    const client = el('input', { placeholder: 'Application (client) ID of your app registration', 'aria-label': `${role}: built-in connector client ID`, disabled: ro });
    const addBuiltin = ui.button('Add built-in', { kind: 'secondary', size: 'sm', iconName: 'plus', disabled: ro, onclick: () => {
      try { addEntries([cv().builtinConnectorEntry({ server: builtinKind.value, tenantId: tenant.value, clientId: client.value })]); } catch (err) { problem.textContent = err.message; }
    } });
    const add = ui.button('Add connector', { kind: 'secondary', size: 'sm', iconName: 'plus', disabled: ro, 'data-key': `connector-add|${role}`, onclick: () => {
      try {
        const entry = cv().connectorEntry({ name: name.value, url: url.value, transport: transport.value, oauth: signIn.value === 'byo' ? 'byo' : signIn.value === 'oauth',
          clientId: oauthClient.value, scope: oauthScope.value });
        if (items.some((i) => i.name === entry.name)) throw new Error(`${entry.name} is already listed.`);
        act.setDesktopList(role, 'managedMcpServers', [...items, entry], `connector-add|${role}`);
      } catch (err) { problem.textContent = err.message; }
    } });
    return el('div', { class: 'stack desktop-list' }, [
      el('h4', { text: 'Connectors (MCP servers)' }),
      el('p', { class: 'muted small', text: 'MCP servers Claude Desktop adds for this role, as on Claude.ai: users sign in to each service the first time they use it, and can turn a connector off. A tool policy in the admin file can block tools.' }),
      items.length ? ui.table({
        caption: `${role} connectors`,
        columns: [
          { label: 'Name', render: (c) => el('strong', { text: c.name }) },
          { label: 'Address', render: (c) => el('code', { text: c.url ?? `built-in: ${c.server}` }) },
          { label: 'Settings', render: (c) => [c.server ? 'built-in' : c.transport === 'sse' ? 'SSE' : 'HTTP', c.oauth === true ? 'OAuth' : c.oauth ? 'OAuth, own client ID' : null, c.toolPolicy ? 'tool policy' : null].filter(Boolean).join(' · ') },
          { label: '', className: 'actions', render: (c) => ui.button('Remove', { kind: 'danger', size: 'sm', iconName: 'trash', disabled: ro, 'aria-label': `Remove connector ${c.name} from ${role}`,
            onclick: () => act.setDesktopList(role, 'managedMcpServers', items.filter((i) => i.name !== c.name), `connector-add|${role}`) }) },
        ],
        rows: items,
      }) : el('p', { class: 'muted small', text: 'No connectors for this role.' }),
      el('h5', { text: 'From the catalog' }),
      el('div', { class: 'form-grid' }, [ui.field({ label: 'Connector', control: pick, className: 'wide' }), el('div', { class: 'form-actions' }, [addPick, addAll])]),
      el('h5', { text: 'Built-in Microsoft 365 or GitHub' }),
      el('div', { class: 'form-grid' }, [ui.field({ label: 'Connector', control: builtinKind }), ui.field({ label: 'Tenant ID', control: tenant, className: 'wide' }),
        ui.field({ label: 'Client ID', control: client, className: 'wide' }), el('div', { class: 'form-actions' }, [addBuiltin])]),
      el('h5', { text: 'Another remote server' }),
      el('div', { class: 'form-grid' }, [
        ui.field({ label: 'Name', control: name }), ui.field({ label: 'URL', control: url, className: 'wide' }),
        ui.field({ label: 'Transport', control: transport }), ui.field({ label: 'Sign-in', control: signIn }),
        ui.field({ label: 'OAuth client ID', control: oauthClient, className: 'wide' }), ui.field({ label: 'OAuth scopes', control: oauthScope, className: 'wide' }),
        el('div', { class: 'form-actions' }, [add]),
      ]),
      problem,
    ]);
  }

  function marketplaces(s, act, role) {
    const items = cv().desktopListOf(s.draft, role, 'allowedPluginMarketplaces');
    const ro = Boolean(s.readOnly);
    const kind = el('select', { 'aria-label': `${role}: marketplace source`, disabled: ro }, [
      el('option', { value: 'github', text: 'GitHub repository' }), el('option', { value: 'git', text: 'Git URL' }), el('option', { value: 'url', text: 'marketplace.json URL' })]);
    const value = el('input', { placeholder: 'owner/name or https://…', 'aria-label': `${role}: marketplace location`, disabled: ro });
    const ref = el('input', { placeholder: 'branch, tag or commit (optional)', 'aria-label': `${role}: marketplace ref`, disabled: ro });
    const problem = el('p', { class: 'cell-problem', role: 'alert' });
    const where = (m) => m.repo ?? m.url;
    const add = ui.button('Add marketplace', { kind: 'secondary', size: 'sm', iconName: 'plus', disabled: ro, 'data-key': `marketplace-add|${role}`, onclick: () => {
      try {
        const entry = cv().marketplaceEntry({ kind: kind.value, value: value.value, ref: ref.value });
        if (items.some((i) => where(i) === where(entry))) throw new Error(`${where(entry)} is already listed.`);
        act.setDesktopList(role, 'allowedPluginMarketplaces', [...items, entry], `marketplace-add|${role}`);
      } catch (err) { problem.textContent = err.message; }
    } });
    const catalog = globalThis.desktopCatalog?.marketplaces ?? [];
    const missing = catalog.filter((c) => !items.some((i) => where(i) === where(c.entry)));
    const addCatalog = ui.button(`Add Anthropic marketplaces (${missing.length})`, { kind: 'ghost', size: 'sm', iconName: 'plus', disabled: ro || !missing.length, 'data-key': `marketplace-catalog|${role}`,
      title: catalog.map((c) => `${where(c.entry)}: ${c.note}`).join('\n'),
      onclick: () => act.setDesktopList(role, 'allowedPluginMarketplaces', [...items, ...missing.map((c) => cv().clone(c.entry))], `marketplace-add|${role}`) });
    return el('div', { class: 'stack desktop-list' }, [
      el('h4', { text: 'Organization plugin marketplaces' }),
      el('p', { class: 'muted small', text: 'Public marketplaces shown in Claude Desktop’s Directory, Organization tab. Private marketplaces need a credential and stay with device management.' }),
      items.length ? ui.table({
        caption: `${role} plugin marketplaces`,
        columns: [
          { label: 'Source', render: (m) => ({ github: 'GitHub', git: 'Git', url: 'marketplace.json' })[m.source] ?? m.source },
          { label: 'Location', render: (m) => el('code', { text: where(m) }) },
          { label: 'Ref', render: (m) => m.ref ?? 'default branch' },
          { label: '', className: 'actions', render: (m) => ui.button('Remove', { kind: 'danger', size: 'sm', iconName: 'trash', disabled: ro, 'aria-label': `Remove marketplace ${where(m)} from ${role}`,
            onclick: () => act.setDesktopList(role, 'allowedPluginMarketplaces', items.filter((i) => where(i) !== where(m)), `marketplace-add|${role}`) }) },
        ],
        rows: items,
      }) : el('p', { class: 'muted small', text: 'No organization marketplaces for this role.' }),
      el('div', { class: 'form-grid' }, [ui.field({ label: 'Source', control: kind }), ui.field({ label: 'Location', control: value, className: 'wide' }),
        ui.field({ label: 'Ref', control: ref }), el('div', { class: 'form-actions' }, [add, addCatalog])]),
      problem,
    ]);
  }

  // Cowork egress: hosts Cowork's sandbox may reach. Empty leaves the gateway's derived list in place.
  function egress(s, act, role) {
    const ro = Boolean(s.readOnly);
    const key = 'coworkEgressAllowedHosts';
    const focus = `desktop-list|${role}|${key}`;
    const items = cv().desktopListOf(s.draft, role, key);
    const problem = el('p', { class: 'cell-problem', role: 'alert' });
    const area = el('textarea', { rows: 6, disabled: ro, 'aria-label': `${role}: Cowork egress hosts`, 'data-key': focus, spellcheck: 'false' });
    area.value = items.join('\n');
    const save = (hosts) => act.setDesktopList(role, key, hosts, focus);
    area.addEventListener('change', () => { try { save(cv().hostsFrom(area.value)); } catch (err) { problem.textContent = err.message; } });
    const common = globalThis.desktopCatalog?.egressHosts ?? [];
    return el('div', { class: 'stack desktop-list' }, [
      el('h4', { text: 'Cowork network access' }),
      el('p', { class: 'muted small', text: 'Hosts Cowork’s sandbox may reach, one per line: github.com, *.github.com (subdomains only) or * for all. This list does not govern web search, model requests or connectors. Any list other than * also keeps Claude Code’s sandbox on.' }),
      ui.field({ label: `Allowed hosts (${items.length})`, control: area, className: 'wide',
        hint: !items.length && cv().desktopListIsSet(s.draft, role, key) ? 'Set to an empty list in the admin file: Cowork may reach no host. Clear removes the setting.' : 'Empty: the gateway derives the list from its sandbox network settings.' }),
      el('div', { class: 'form-actions' }, [
        ui.button(`Add common domains (${common.length})`, { kind: 'secondary', size: 'sm', iconName: 'plus', disabled: ro || !common.length, 'data-key': `egress-common|${role}`,
          onclick: () => save([...new Set([...items.filter((h) => h !== '*'), ...common])]) }),
        ui.button('Allow all hosts (*)', { kind: 'ghost', size: 'sm', disabled: ro, onclick: () => save(['*']) }),
        ui.button('Clear', { kind: 'ghost', size: 'sm', disabled: ro || !cv().desktopListIsSet(s.draft, role, key), onclick: () => save([]) }),
      ]),
      problem,
    ]);
  }

  // Plugin MCP server limits and the import organization list, one value per line; an empty box leaves the setting unset.
  function patterns(s, act, role) {
    const ro = Boolean(s.readOnly);
    const box = (key, label, hint, toText, fromText, emptyMeans) => {
      const area = el('textarea', { rows: 3, disabled: ro, 'aria-label': `${role}: ${label}`, 'data-key': `desktop-list|${role}|${key}`, spellcheck: 'false' });
      const items = cv().desktopListOf(s.draft, role, key);
      area.value = toText(items);
      area.addEventListener('change', () => act.setDesktopList(role, key, fromText(area.value), `desktop-list|${role}|${key}`));
      const explicitEmpty = !items.length && cv().desktopListIsSet(s.draft, role, key);
      return ui.field({ label, control: area, hint: explicitEmpty ? `Set to an empty list in the admin file: ${emptyMeans}. Saving an empty box removes the setting.` : hint, className: 'wide' });
    };
    const lines = (items) => items.join('\n');
    const uuids = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return el('div', { class: 'stack desktop-list' }, [
      el('h4', { text: 'Plugin servers and import sources' }),
      el('div', { class: 'form-grid' }, [
        box('allowedPluginMcpServers', 'Allowed plugin MCP servers', 'One https:// pattern per line, * allowed. Empty: no limit.', cv().patternsText, cv().patternsFrom, 'plugins may start no MCP server'),
        box('deniedPluginMcpServers', 'Blocked plugin MCP servers', 'One https:// pattern per line. Applies even when the allowed list matches.', cv().patternsText, cv().patternsFrom, 'nothing is blocked'),
        box('claudeAiImport.allowedOrganizationUuids', 'Claude.ai organizations users may import from', 'One organization UUID per line. Empty: any organization, when import is enabled.', lines, uuids, 'no organization may be imported from'),
      ]),
    ]);
  }

  return { matrix, admission, models, softLimit, desktop };
})();
