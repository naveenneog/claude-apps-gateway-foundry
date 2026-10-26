// Builders for the review and roll-out steps of Access & models: the flow strip, preview problems placed under what
// they name, the change list with the rendered gateway.yaml, the Apply confirmation (with the acknowledgement a gateway
// on a temporary database needs) and the roll-out progress. access-page.js owns the state and calls the API.
const accessReview = (() => {
  const cv = () => configView;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const clock = (value) => {
    const at = value ? new Date(value) : new Date();
    return Number.isNaN(at.getTime()) ? '' : `${at.toISOString().slice(11, 19)} UTC`;
  };
  const name = (text) => el('span', { class: 'nowrap', text });

  function flow(mode) {
    const steps = [['edit', 'Edit'], ['review', 'Review'], ['rollout', 'Roll out']];
    const at = steps.findIndex(([key]) => key === mode);
    return el('ol', { class: 'flow', 'aria-label': 'Steps to change the gateway configuration' }, steps.map(([key, label], i) => el('li', {
      class: ['flow-step', i < at && 'done', i === at && 'current'].filter(Boolean).join(' '), 'aria-current': i === at ? 'step' : null,
    }, [el('span', { class: 'flow-n', 'aria-hidden': 'true' }, [i < at ? ui.icon('check', 12) : String(i + 1)]), el('span', { text: label })])));
  }

  function errorsPanel(errors, admin) {
    const items = cv().describeErrors(errors, admin);
    return ui.banner('error', [el('ul', { class: 'error-list' }, items.map((e) => el('li', {}, [el('strong', { text: e.where }), el('span', { text: e.message })])))], {
      title: `The gateway would not accept this configuration: ${plural(items.length, 'problem', 'problems')}`,
    });
  }

  // Hyphenated identifiers (claude-sonnet-5) wrap as a whole, not at their hyphens.
  const keepWhole = (line) => String(line).split(/(\S+-\S+)/).map((part, i) => (i % 2 ? el('span', { class: 'keep', text: part }) : part));

  function changeList(changes, className = '') {
    return el('ul', { class: `change-list ${className}`.trim() }, changes.map((line) => el('li', {}, [el('span', { class: 'change-mark', 'aria-hidden': 'true' }), el('span', { class: 'change-text' }, keepWhole(line))])));
  }

  // blocked: a reason Apply cannot run (read-only, or the configuration changed underneath); null when it can.
  function reviewPanel({ preview, config, blocked, onBack, onApply }) {
    const changes = Array.isArray(preview?.changes) ? preview.changes : [];
    const yaml = typeof preview?.yaml === 'string' ? preview.yaml : null;
    const back = ui.button('Back to editing', { kind: 'secondary', 'data-key': 'back' });
    const apply = ui.button('Apply and roll out', { kind: 'primary', iconName: 'arrow', 'data-key': 'apply', disabled: Boolean(blocked) || !changes.length });
    back.addEventListener('click', onBack);
    apply.addEventListener('click', () => onApply(apply));
    return ui.card({
      title: 'Review changes', className: 'review',
      description: `Compared with the configuration ${config.gateway?.app ?? 'the gateway'} runs now. The gateway checked the draft and accepts it.`,
      content: [
        el('div', { class: 'card-body stack' }, [
          changes.length
            ? el('div', { class: 'stack-xs' }, [el('p', { class: 'section-label', text: plural(changes.length, 'change', 'changes') }), changeList(changes)])
            : ui.empty('No changes', 'The draft matches the configuration the gateway runs now.'),
          yaml !== null ? el('details', { class: 'yaml' }, [
            el('summary', {}, [el('span', { text: 'Rendered gateway.yaml' }), el('span', { class: 'muted small', text: plural(yaml.trimEnd().split('\n').length, 'line', 'lines') })]),
            el('pre', { class: 'code-block', tabindex: '0', 'aria-label': 'Rendered gateway.yaml' }, [el('code', { text: yaml })]),
          ]) : null,
        ]),
        el('div', { class: 'card-footer' }, [
          blocked ? el('p', { class: 'footer-note', text: blocked }) : el('p', { class: 'footer-note', text: 'Applying starts a new revision of the gateway.' }),
          el('div', { class: 'footer-actions' }, [back, apply]),
        ]),
      ],
    });
  }

  // warning: the data-loss text when the gateway's database is temporary; the admin then has to tick the box.
  function confirmApply({ app, changes, warning }) {
    const list = Array.isArray(changes) ? changes : [];
    return ui.confirm({
      title: 'Apply and roll out?',
      body: [
        `The gateway reads its configuration only when it starts, so applying starts a new revision of ${app || 'the gateway app'}. The current revision keeps serving until the new one is running and healthy.`,
        el('div', { class: 'stack-xs' }, [el('p', { class: 'section-label', text: plural(list.length, 'change', 'changes') }), changeList(list, 'compact')]),
      ],
      warning: warning || null,
      acknowledge: warning ? 'I understand spend totals, caps and the audit trail are reset' : null,
      confirmText: 'Apply and roll out',
    });
  }

  const TITLES = { running: 'Rolling out', succeeded: 'Rolled out', failed: 'Roll-out failed', timeout: 'Roll-out not finished' };
  const STATE_TEXT = { done: 'done', current: 'in progress', failed: 'failed', pending: 'not started' };

  // r: the page's roll-out record { app, previous, requestedAt, admin, temporaryDatabase, status, outcome, error }.
  // update(r) redraws the steps in place; only the status line is a live region, so each change is announced once.
  function rolloutPanel(r, { onDone, onWait }) {
    const titleId = ui.uid('rollout');
    const title = el('h3', { id: titleId, tabindex: '-1' });
    const steps = el('ol', { class: 'stepper' });
    const live = el('p', { class: 'rollout-message', role: 'status', 'aria-live': 'polite' });
    const checked = el('p', { class: 'muted small' });
    const outcome = el('div', { class: 'stack' });
    const requested = r.requestedAt ? `, requested at ${clock(r.requestedAt)}` : '';
    const summary = el('p');
    const node = el('section', { class: 'card rollout', 'aria-labelledby': titleId }, [
      el('div', { class: 'card-header' }, [el('div', { class: 'card-title' }, [title, summary])]),
      el('div', { class: 'card-body stack' }, [steps, live, checked, outcome]),
    ]);
    let said = '';

    function outcomeParts(state) {
      const latest = state.status?.latestRevision;
      const done = ui.button(state.outcome === 'succeeded' ? 'Done' : 'Back to the editor', { kind: state.outcome === 'succeeded' ? 'primary' : 'secondary', onclick: onDone });
      if (state.outcome === 'succeeded') {
        return [
          ui.banner('success', [
            `${latest ? `Revision ${latest}` : 'The new revision'} is running and healthy.`,
            r.previous ? `It replaced the previous revision (${r.previous}).` : null,
          ].filter(Boolean), { title: 'The change is live' }),
          state.temporaryDatabase ? ui.banner('info', [cv().budgetsNote(state.admin)], { actions: [el('a', { class: 'btn secondary sm', href: '#/budgets' }, [el('span', { text: 'Open Budgets' }), ui.icon('arrow', 14)])] }) : null,
          el('div', { class: 'footer-actions' }, [done]),
        ];
      }
      if (state.outcome === 'failed') {
        return [
          ui.banner('error', [
            `The previous revision${r.previous ? ` (${r.previous})` : ''} keeps serving.`,
            'The configuration you applied stays saved on the gateway app. Correct it and apply again.',
          ], { title: `${latest ? `Revision ${latest}` : 'The new revision'} failed` }),
          el('div', { class: 'footer-actions' }, [done]),
        ];
      }
      if (state.outcome === 'timeout') {
        return [
          ui.banner('warning', ['The new revision is not running and healthy after 10 minutes. The gateway app’s Revisions page in the Azure portal shows its state.'], {
            title: 'Still rolling out', actions: [ui.button('Keep waiting', { kind: 'secondary', size: 'sm', iconName: 'refresh', onclick: onWait })],
          }),
          el('div', { class: 'footer-actions' }, [done]),
        ];
      }
      return [el('p', { class: 'muted small', text: 'Other admin-ui pages can be opened meanwhile; a notification reports the outcome.' })];
    }

    function update(state) {
      const status = state.status ?? { previousRevision: r.previous, latestRevision: null };
      steps.replaceChildren(...cv().rolloutSteps(status).map((step) => el('li', { class: `step ${step.state}` }, [
        el('span', { class: 'step-icon', 'aria-hidden': 'true' }, [step.state === 'done' ? ui.icon('check', 13) : step.state === 'failed' ? ui.icon('x', 13) : null]),
        el('div', { class: 'step-main' }, [
          el('span', { class: 'step-label', text: step.label }),
          step.detail ? el('span', { class: 'step-detail', text: step.detail }) : null,
          el('span', { class: 'visually-hidden', text: `: ${STATE_TEXT[step.state] ?? step.state}` }),
        ]),
      ])));
      title.textContent = TITLES[state.outcome] ?? TITLES.running;
      const final = state.outcome === 'succeeded' || state.outcome === 'failed';
      summary.replaceChildren('A new revision of ', name(r.app || 'the gateway app'), `${requested}.`,
        ...(final ? [] : [' The previous revision', ...(r.previous ? [' (', name(r.previous), ')'] : []), ' serves until it is ready.']));
      node.dataset.outcome = state.outcome;
      // Once the outcome banner shows, the status line is only announced, not shown a second time.
      live.classList.toggle('visually-hidden', final);
      const text = cv().rolloutMessage(state.status);
      if (text !== said) { live.textContent = text; said = text; }
      checked.textContent = state.error
        ? `Could not read the roll-out status (${state.error}). Trying again in 3 seconds.`
        : (state.checkedAt ? `Checked at ${clock(state.checkedAt)}` : '');
      outcome.replaceChildren(...outcomeParts(state).filter(Boolean));
    }

    return { node, update, focus: () => title.focus() };
  }

  return { flow, errorsPanel, changeList, reviewPanel, confirmApply, rolloutPanel };
})();
