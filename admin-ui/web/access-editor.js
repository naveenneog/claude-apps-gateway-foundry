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

  return { matrix, admission, models, softLimit };
})();
