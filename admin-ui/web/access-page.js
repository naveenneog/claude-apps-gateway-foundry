// The Access & models page (ADR-0010): which models each admitted role may use and whether it may use Claude Desktop.
// The admin file is edited as a local draft (accessEditor), checked by the gateway's own rules (POST
// /api/gateway-config/preview), applied as a new gateway revision (PUT /api/gateway-config) and followed until that
// revision is running and healthy (GET /api/gateway-config/rollout; accessReview). Keys the editor does not touch
// ($comment, deployment, budgets) travel unchanged, because every edit is configView's copy of the whole file.
const accessPage = (() => {
  const cv = configView;
  const POLL_MS = 3000;
  const TIMEOUT_MS = 10 * 60 * 1000;
  const DIFFERS = 'The live configuration differs from the file admin-ui was deployed with. Download it and commit it to the repository.';

  // One roll-out at a time, kept across page visits: polling goes on while the admin is on another page, and a toast
  // reports the outcome there. The page that shows it sets listener.
  let rollout = null;

  function startRollout(record) {
    rollout = { ...record, status: null, outcome: 'running', error: null, checkedAt: null, startedAt: Date.now(), listener: null };
    setTimeout(poll, 0);
  }

  async function poll() {
    const r = rollout;
    if (!r || r.outcome !== 'running') return;
    const query = r.previous ? `?previous=${encodeURIComponent(r.previous)}` : '';
    const result = await ui.settle(api.get(`/api/gateway-config/rollout${query}`));
    if (rollout !== r) return;
    if (result instanceof Error) r.error = result.message;
    else Object.assign(r, { error: null, status: result, outcome: cv.rolloutOutcome(result), checkedAt: new Date().toISOString() });
    if (r.outcome === 'running' && Date.now() - r.startedAt > TIMEOUT_MS) r.outcome = 'timeout';
    if (r.outcome === 'running') setTimeout(poll, POLL_MS);
    else finished(r);
    r.listener?.(r);
  }

  function finished(r) {
    ui.invalidate('/api/roles');
    ui.invalidate('/api/gateway-config');
    if (r.listener) return;
    const app = r.app || 'the gateway app';
    if (r.outcome === 'succeeded') ui.toast(`The new revision of ${app} is running and healthy.`);
    else if (r.outcome === 'failed') ui.toast(`The new revision of ${app} failed. The previous revision keeps serving.`, 'error');
    else ui.toast(`The new revision of ${app} is not healthy after 10 minutes.`, 'warning');
  }

  const SOURCE_TEXT = { live: 'Saved on the gateway app', deploy: 'The file admin-ui was deployed with' };

  async function render(ctx) {
    const view = el('div', { class: 'stack page-body' });
    const header = ui.pageHeader({ title: 'Access & models', description: 'Which models each admitted role can use, and whether it can use Claude Desktop. A change is applied as a new gateway revision.' });
    ctx.root.replaceChildren(header, view);
    const s = { mode: 'edit', config: null };
    const fresh = () => ({ role: new Set(), model: new Set() });
    ctx.setGuard(() => (s.config && s.mode !== 'rollout' && cv.isDirty(s.original, s.draft) ? 'Your changes to access and models are not applied. Leave and discard them?' : null));

    async function load(admitRole) {
      view.replaceChildren(ui.skeleton('block'), ui.skeleton('table', 4), ui.loading('Loading the gateway configuration'));
      const [config, roles, caps] = await Promise.all([
        ui.settle(api.get('/api/gateway-config')),
        ui.settle(ui.shared('/api/roles', { fresh: true })),
        ui.settle(ui.shared('/api/capabilities')),
      ]);
      if (!ctx.active()) return;
      if (config instanceof Error) {
        s.config = null;
        const failure = cv.loadFailure(config.message, caps instanceof Error ? null : caps);
        view.replaceChildren(ui.banner('error', [...failure.lines, failure.detail && el('p', { class: 'banner-detail', text: failure.detail })], {
          title: failure.title,
          actions: [ui.button('Try again', { kind: 'secondary', size: 'sm', iconName: 'refresh', onclick: () => load() }), ui.settingsLink()],
        }));
        return;
      }
      const capabilities = caps instanceof Error ? null : caps;
      Object.assign(s, {
        config, roles, mode: 'edit', original: cv.clone(config.admin), draft: cv.clone(config.admin),
        readOnly: cv.readOnlyReason(config, capabilities), preview: null, errors: [], problem: null, notice: null,
        needsAck: false, ackMessage: null, flagged: fresh(), focusKey: null,
      });
      if (admitRole) prefill(admitRole);
      draw();
    }

    function prefill(role) {
      const entra = s.roles instanceof Error ? null : (s.roles?.roles ?? []).find((r) => r.value === role);
      if ((s.draft.roles ?? []).includes(role)) { s.notice = { kind: 'info', text: `${role} is already admitted. Its models are in Role access.` }; return; }
      if (s.readOnly) { s.notice = { kind: 'warning', text: `${role} cannot be admitted from here: the page is read-only.` }; return; }
      if (!entra && !(s.roles instanceof Error)) { s.notice = { kind: 'warning', text: `${role} is not one of the gateway app’s roles in Entra ID.` }; return; }
      if (entra?.isEnabled === false) { s.notice = { kind: 'warning', text: `${role} is disabled in Entra ID. Enable it there to admit it.` }; return; }
      s.draft = cv.admitRole(s.draft, role, s.original);
      const first = s.draft.models?.[0]?.id;
      s.focusKey = Array.isArray(s.draft.policies) && first ? `model|${role}|${first}` : `admit|${role}`;
      s.notice = { kind: 'info', text: Array.isArray(s.draft.policies)
        ? `${role} is admitted in this draft. Tick the models it can use, then review the changes.`
        : `${role} is admitted in this draft and can use every model. Review the changes to apply it.` };
    }

    function draw() {
      const focused = view.contains(document.activeElement) ? document.activeElement.closest('[data-key]')?.dataset.key : null;
      const focusKey = s.focusKey ?? focused;
      s.focusKey = null;
      const body = s.mode === 'review'
        ? [accessReview.reviewPanel({ preview: s.preview, config: s.config, blocked: blocked(), onBack: back, onApply: apply })]
        : [accessEditor.matrix(s, act), accessEditor.models(s, act), accessEditor.admission(s, act), dirtyBar()];
      view.replaceChildren(...[accessReview.flow(s.mode), ...banners(), s.mode === 'edit' ? facts() : null, ...body].filter(Boolean));
      if (focusKey) view.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    }

    const warning = () => cv.dataLossWarning(s.config) ?? (s.needsAck ? s.ackMessage : null);
    function blocked() {
      if (s.readOnly) return s.readOnly;
      if (s.problem?.kind === 'conflict') return 'The configuration changed after it was loaded. Reload it, then make the change again.';
      return null;
    }

    function banners() {
      const out = [];
      if (s.readOnly) out.push(ui.banner('warning', [s.readOnly, 'The configuration is shown read-only.'], { title: 'Changes are not available', actions: [ui.settingsLink('Permissions')] }));
      if (s.config.deployFileMatches === false) {
        out.push(s.config.source === 'deploy'
          ? ui.banner('warning', ['The gateway’s running gateway.yaml is not the rendering of the file admin-ui was deployed with. The editor starts from that file; applying a change replaces the running configuration.'], { title: 'Running configuration differs' })
          : ui.banner('warning', [DIFFERS], { title: 'Not in the repository', actions: [ui.button('Download admin file', { kind: 'secondary', size: 'sm', iconName: 'download', onclick: () => ui.download(cv.downloadName(s.config.adminFilePath), cv.adminFileText(s.config.admin)) })] }));
      }
      if (warning()) out.push(ui.banner('warning', [warning()], { title: 'This gateway’s database is temporary' }));
      if (s.notice) out.push(ui.banner(s.notice.kind, [s.notice.text]));
      if (s.errors.length) out.push(accessReview.errorsPanel(s.errors, s.draft));
      if (s.problem) out.push(problemBanner(s.problem));
      return out;
    }

    function problemBanner(problem) {
      if (problem.kind === 'conflict') {
        return ui.banner('error', ['Someone else changed the gateway configuration after this page loaded it, so this change was not applied. Reload to start from their version; reloading discards the edits here, so download them first to keep a copy.'], {
          title: 'The configuration changed',
          actions: [
            ui.button('Reload', { kind: 'primary', size: 'sm', iconName: 'refresh', onclick: () => load() }),
            ui.button('Download your edits', { kind: 'secondary', size: 'sm', iconName: 'download', onclick: () => ui.download(cv.downloadName(s.config.adminFilePath), cv.adminFileText(s.draft)) }),
          ],
        });
      }
      if (problem.kind === 'forbidden') return ui.banner('error', [problem.message], { title: 'Not permitted', actions: [ui.settingsLink('Permissions')] });
      return ui.banner('error', [problem.message], { title: problem.title ?? 'The change was not applied' });
    }

    function facts() {
      const c = s.config;
      const item = (label, value, mono = false) => el('div', { class: 'meta-item' }, [el('dt', { text: label }), el('dd', { class: mono ? 'mono' : null, text: value || '—' })]);
      return el('dl', { class: 'meta-strip' }, [
        item('Gateway app', c.gateway?.app, true),
        item('Revision', c.gateway?.revision, true),
        item('Topology', c.topology ? c.topology[0].toUpperCase() + c.topology.slice(1) : null),
        item('Admin file', cv.downloadName(c.adminFilePath), true),
        item('Loaded from', SOURCE_TEXT[c.source] ?? c.source),
      ]);
    }

    function dirtyBar() {
      if (s.readOnly || !cv.isDirty(s.original, s.draft)) return null;
      const problems = cv.problems(s.draft);
      const review = ui.button('Review changes', { kind: 'primary', iconName: 'arrow', 'data-key': 'review', disabled: problems.length > 0 });
      review.addEventListener('click', () => preview(review));
      return el('div', { class: 'dirty-bar', role: 'region', 'aria-label': 'Changes not applied' }, [
        el('div', { class: `dirty-text${problems.length ? ' warn' : ''}` }, [
          ui.icon(problems.length ? 'warning' : 'edit', 16),
          el('span', { text: problems.length ? problems.map((p) => p.message).join(' ') : 'Changes not applied. The gateway is unchanged until they are reviewed and applied.' }),
        ]),
        el('div', { class: 'dirty-actions' }, [ui.button('Discard', { kind: 'ghost', 'data-key': 'discard', onclick: discard }), review]),
      ]);
    }

    function change(next, focusKey) {
      Object.assign(s, { draft: next, errors: [], problem: s.problem?.kind === 'conflict' ? s.problem : null, notice: null, flagged: fresh() });
      if (focusKey) s.focusKey = focusKey;
      draw();
    }

    const act = {
      toggleModel: (role, id, on) => change(cv.toggleModel(s.draft, role, id, on, s.original)),
      setDesktop: (role, on) => change(cv.setDesktop(s.draft, role, on, s.original)),
      admit: (role) => {
        const next = cv.admitRole(s.draft, role, s.original);
        const first = next.models?.[0]?.id;
        const noModels = Array.isArray(next.policies) && !(next.policies.find((p) => p.role === role)?.models ?? []).length;
        change(next, noModels && first ? `model|${role}|${first}` : `admit|${role}`);
      },
      unadmit: (role) => change(cv.unadmitRole(s.draft, role)),
      removeModel: (id) => change(cv.removeModel(s.draft, id), 'add-model'),
      saveModel: (values, previousId) => change(cv.upsertModel(s.draft, values, previousId), previousId === null ? 'add-model' : `edit|${String(values.id).trim()}`),
    };

    async function discard() {
      const ok = await ui.confirm({ title: 'Discard the changes?', body: ['The draft goes back to the configuration the gateway runs now.'], confirmText: 'Discard changes', danger: true });
      if (!ok || !ctx.active()) return;
      Object.assign(s, { draft: cv.clone(s.original), errors: [], problem: null, notice: null, flagged: fresh(), mode: 'edit' });
      draw();
    }

    function flag(errors) {
      s.flagged = fresh();
      for (const e of cv.describeErrors(errors, s.draft)) if (e.key && s.flagged[e.kind]) s.flagged[e.kind].add(e.key);
    }

    async function preview(btn) {
      ui.busy(btn, true, 'Checking…');
      const result = await ui.settle(api.post('/api/gateway-config/preview', { admin: s.draft }));
      if (!ctx.active()) return;
      ui.busy(btn, false);
      if (result instanceof Error) {
        s.problem = { kind: 'error', title: 'Could not check the changes', message: result.message };
      } else if (Array.isArray(result.errors) && result.errors.length) {
        Object.assign(s, { errors: result.errors, problem: null });
        flag(result.errors);
      } else {
        Object.assign(s, { mode: 'review', preview: result, errors: [], problem: null, notice: null });
      }
      draw();
      focusTop();
    }

    function focusTop() {
      const target = view.querySelector('.banner.error, .card.review h3');
      if (!target) return;
      target.setAttribute('tabindex', '-1');
      target.focus();
    }

    function back() {
      Object.assign(s, { mode: 'edit', preview: null, problem: s.problem?.kind === 'conflict' ? s.problem : null, focusKey: 'review' });
      draw();
    }

    async function apply(btn) {
      const ok = await accessReview.confirmApply({ app: s.config.gateway?.app, changes: s.preview?.changes, warning: warning() });
      if (!ok || !ctx.active()) return;
      ui.busy(btn, true, 'Applying…');
      const body = { admin: s.draft, baseVersion: s.config.version, acknowledgeDataLoss: Boolean(warning()) };
      const result = await ui.settle(api.put('/api/gateway-config', body));
      if (!(result instanceof Error)) {
        startRollout({
          app: s.config.gateway?.app, previous: result.rollout?.previousRevision ?? s.config.gateway?.revision ?? null,
          requestedAt: result.rollout?.requestedAt ?? null, admin: cv.clone(s.draft), temporaryDatabase: Boolean(warning()),
        });
        s.original = cv.clone(s.draft);
        ui.invalidate('/api/roles');
        ui.invalidate('/api/gateway-config');
        if (ctx.active()) showRollout();
        return;
      }
      if (!ctx.active()) return;
      ui.busy(btn, false);
      const problem = cv.applyError(result.status, result.body);
      if (problem.kind === 'acknowledge') {
        Object.assign(s, { needsAck: true, ackMessage: problem.message });
        draw();
        const again = view.querySelector('[data-key="apply"]');
        if (again) apply(again);
        return;
      }
      if (problem.kind === 'invalid') {
        Object.assign(s, { mode: 'edit', preview: null, errors: problem.errors.length ? problem.errors : [problem.message], problem: null });
        flag(s.errors);
      } else {
        s.problem = problem;
      }
      draw();
      focusTop();
    }

    function showRollout() {
      s.mode = 'rollout';
      const r = rollout;
      const panel = accessReview.rolloutPanel(r, {
        onDone: () => { if (rollout === r) rollout = null; load(); },
        onWait: () => { Object.assign(r, { outcome: 'running', startedAt: Date.now() }); poll(); },
      });
      const listener = (state) => { if (ctx.active()) panel.update(state); };
      r.listener = listener;
      ctx.onLeave(() => { if (r.listener === listener) r.listener = null; });
      view.replaceChildren(accessReview.flow('rollout'), panel.node);
      panel.update(r);
      panel.focus();
    }

    // Last, so every const above is initialised before load() draws.
    const admit = ctx.query.get('admit');
    if (admit) ctx.replaceHash('#/access');
    if (rollout) { showRollout(); return; }
    await load(admit);
  }

  return { title: 'Access & models', render };
})();
