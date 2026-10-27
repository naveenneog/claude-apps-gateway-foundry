// Pure helpers for the Access & models page: edits to the admin file (ADR-0010), its validation messages, and the
// rollout of the revision a save starts. Every edit returns a new object and leaves keys it does not own ($comment,
// deployment, budgets, unknown model keys) exactly as read. The rules mirror adminErrors() in
// scripts/admin/new-gateway-config.mjs; the server's preview stays the authority. Loaded before app.js as a classic
// script; tests/admin-ui-web.test.mjs loads it in node:vm.
(() => {
  const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
  const DEFAULT_WARNING = 'This gateway keeps its database on temporary storage. Applying a change starts a new revision, '
    + 'which resets spend totals, spend caps and the audit trail; developers may need to sign in again.';

  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const list = (value) => (Array.isArray(value) ? value : []);
  const modelIds = (admin) => list(admin?.models).map((m) => m.id);
  const policyOf = (admin, role) => list(admin?.policies).find((p) => p.role === role) ?? null;
  const desktopDefault = (admin) => admin?.deployment?.desktop === true;
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const names = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

  // The first matrix edit on a file without policies writes what the gateway does today: every role, every model.
  function withPolicies(admin) {
    const next = clone(admin);
    if (!Array.isArray(next.policies)) next.policies = list(next.roles).map((role) => ({ role, models: modelIds(next) }));
    return next;
  }

  function insertAt(items, index, item) {
    const at = index < 0 ? items.length : Math.min(index, items.length);
    items.splice(at, 0, item);
  }

  const configView = {
    clone,
    isDirty(original, draft) { return JSON.stringify(original) !== JSON.stringify(draft); },

    allowedModels(admin, role) {
      if (!Array.isArray(admin?.policies)) return modelIds(admin);
      return [...(policyOf(admin, role)?.models ?? [])];
    },

    // A policy's own desktop wins; absent, deployment.desktop's default applies. With no policies nothing carries it.
    desktopOf(admin, role) {
      if (!Array.isArray(admin?.policies)) return false;
      const policy = policyOf(admin, role);
      if (!policy) return false;
      return policy.desktop !== undefined ? policy.desktop === true : desktopDefault(admin);
    },

    // Matrix keys (as the cells' data-key) that differ from the configuration as read: model|role|id, desktop|role,
    // and row|role for a role that was not admitted before.
    changedCells(original, draft) {
      const was = list(original?.roles);
      return list(draft?.roles).flatMap((role) => {
        if (!was.includes(role)) return [`row|${role}`];
        const before = new Set(configView.allowedModels(original, role));
        const now = new Set(configView.allowedModels(draft, role));
        return [
          ...modelIds(draft).filter((id) => before.has(id) !== now.has(id)).map((id) => `model|${role}|${id}`),
          ...(configView.desktopOf(original, role) !== configView.desktopOf(draft, role) ? [`desktop|${role}`] : []),
        ];
      });
    },

    toggleModel(admin, role, modelId, on, original) {
      const next = withPolicies(admin);
      const policy = policyOf(next, role);
      if (!policy) return next;
      const wanted = new Set(policy.models ?? []);
      if (on) wanted.add(modelId); else wanted.delete(modelId);
      const kept = policyOf(original, role)?.models;
      policy.models = Array.isArray(kept) && sameSet(kept, [...wanted]) ? [...kept] : modelIds(next).filter((id) => wanted.has(id));
      return next;
    },

    setDesktop(admin, role, on, original) {
      const next = withPolicies(admin);
      const policy = policyOf(next, role);
      if (!policy) return next;
      const before = policyOf(original, role);
      if (before && !('desktop' in before) && on === desktopDefault(next)) delete policy.desktop;
      else policy.desktop = on;
      return next;
    },

    // ADR-0014: the soft limit, spendPacing.softLimitPercent in the admin file; null is off, with the key removed.
    softLimitOf(admin) { return Number.isInteger(admin?.spendPacing?.softLimitPercent) ? admin.spendPacing.softLimitPercent : null; },
    setSoftLimit(admin, percent) {
      const next = clone(admin);
      if (percent === null) delete next.spendPacing;
      else next.spendPacing = { softLimitPercent: percent };
      return next;
    },
    softLimitError(admin, percent) {
      if (admin?.deployment?.adminApi !== true) return 'The soft limit needs the gateway’s admin API, which this admin file does not turn on.';
      return Number.isInteger(percent) && percent >= 1 && percent <= 99 ? null : 'Enter a whole number from 1 to 99.';
    },

    // Admitting needs a policy (adminErrors: every admitted role has one), so one is created with no models yet; a
    // role admitted before comes back with its original policy and position.
    admitRole(admin, role, original) {
      const next = clone(admin);
      next.roles = list(next.roles);
      if (next.roles.includes(role)) return next;
      insertAt(next.roles, list(original?.roles).indexOf(role), role);
      if (Array.isArray(next.policies)) {
        const before = policyOf(original, role);
        if (before) insertAt(next.policies, list(original.policies).indexOf(before), clone(before));
        else next.policies.push({ role, models: [] });
      }
      return next;
    },

    unadmitRole(admin, role) {
      const next = clone(admin);
      next.roles = list(next.roles).filter((r) => r !== role);
      if (Array.isArray(next.policies)) next.policies = next.policies.filter((p) => p.role !== role);
      return next;
    },

    unadmitBlocker(admin, role) {
      const roles = list(admin?.roles);
      if (roles.length <= 1 && roles.includes(role)) return 'The gateway needs at least one role admitted.';
      const budgets = list(admin?.budgets).map((b, i) => [b, i]).filter(([b]) => b?.scope?.type === 'rbac_group' && b.scope.rbac_group_id === role);
      if (budgets.length) {
        return `A budget in the admin file names ${role} (budget ${budgets.map(([, i]) => i + 1).join(', ')}), so it stays admitted. Remove that budget from the file first.`;
      }
      return null;
    },

    modelUsers(admin, modelId) {
      return list(admin?.policies).filter((p) => list(p.models).includes(modelId)).map((p) => p.role);
    },

    modelRemovalBlocker(admin, modelId) {
      if (list(admin?.models).length <= 1) return 'The gateway needs at least one model.';
      const users = configView.modelUsers(admin, modelId);
      if (!users.length) return null;
      return `Used by ${names(users)}. Untick it for ${users.length === 1 ? 'that role' : 'those roles'} in Role access first.`;
    },

    removeModel(admin, modelId) {
      const next = clone(admin);
      next.models = list(next.models).filter((m) => m.id !== modelId);
      return next;
    },

    // Field messages for the add/edit model dialog; an empty object when the model can be saved.
    modelErrors(admin, model, previousId) {
      const errors = {};
      const id = String(model?.id ?? '').trim();
      const deployment = String(model?.deployment ?? '').trim();
      const label = String(model?.label ?? '').trim();
      const pattern = 'Use letters, digits and . _ : / @ -, starting with a letter or digit.';
      if (!id) errors.id = 'Enter the model ID developers select.';
      else if (!MODEL_NAME.test(id)) errors.id = pattern;
      else if (list(admin?.models).some((m) => m.id === id && m.id !== previousId)) errors.id = `${id} is already listed.`;
      if (!deployment) errors.deployment = 'Enter the Foundry deployment name.';
      else if (!MODEL_NAME.test(deployment)) errors.deployment = pattern;
      if (label.length > 100) errors.label = 'Use at most 100 characters.';
      else if (/[\x00-\x1f\x7f$]/.test(label)) errors.label = 'Remove control characters and $, which the gateway reads as the start of a ${...} reference.';
      return errors;
    },

    upsertModel(admin, model, previousId) {
      const next = clone(admin);
      next.models = list(next.models);
      const id = String(model.id).trim();
      const label = String(model.label ?? '').trim();
      const index = previousId === null || previousId === undefined ? -1 : next.models.findIndex((m) => m.id === previousId);
      const entry = index >= 0 ? next.models[index] : { id, label, deployment: '' };
      entry.id = id;
      if (label) entry.label = label; else delete entry.label;
      entry.deployment = String(model.deployment).trim();
      if (index >= 0) next.models[index] = entry; else next.models.push(entry);
      if (index >= 0 && previousId !== id && Array.isArray(next.policies)) {
        for (const p of next.policies) p.models = list(p.models).map((m) => (m === previousId ? id : m));
      }
      return next;
    },

    // What the editor can tell before a preview: an admitted role whose policy lists no model.
    problems(admin) {
      if (!Array.isArray(admin?.policies)) return [];
      return list(admin.roles).filter((role) => !list(policyOf(admin, role)?.models).length)
        .map((role) => ({ role, message: `${role} is admitted with no model. Tick at least one, or stop admitting it.` }));
    },

    // Preview and save errors are "field: message"; each is placed under the model, role or budget it names.
    describeErrors(errors, admin) {
      return list(errors).map((text) => {
        const match = /^([A-Za-z$][\w$]*(?:\[\d+\])?(?:\.[\w$]+(?:\[\d+\])?)*): ([\s\S]*)$/.exec(String(text));
        if (!match) return { where: 'Configuration', kind: 'other', key: null, message: String(text) };
        const [, field, message] = match;
        const indexed = /^(models|policies|budgets)\[(\d+)\](?:\.(.+))?$/.exec(field);
        if (indexed) {
          const [, section, n, rest] = indexed;
          const i = Number(n);
          if (section === 'models') {
            const id = admin?.models?.[i]?.id ?? null;
            return { where: `Model ${id ?? `#${i + 1}`}${rest ? ` · ${rest}` : ''}`, kind: 'model', key: id, message };
          }
          if (section === 'policies') {
            const role = admin?.policies?.[i]?.role ?? null;
            return { where: `Role ${role ?? `policy #${i + 1}`}${rest ? ` · ${rest}` : ''}`, kind: 'role', key: role, message };
          }
          return { where: `Budget ${i + 1} in the admin file`, kind: 'budget', key: null, message };
        }
        if (field === 'policies' || field === 'roles') {
          const role = list(admin?.roles).find((r) => new RegExp(`(^|\\s)${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(message)) ?? null;
          if (role) return { where: `Role ${role}`, kind: 'role', key: role, message };
          return { where: field === 'roles' ? 'Admitted roles' : 'Role access', kind: 'other', key: null, message };
        }
        if (field === 'models') return { where: 'Models', kind: 'other', key: null, message };
        return { where: field, kind: 'other', key: null, message };
      });
    },

    adminFileText(admin) { return `${JSON.stringify(admin, null, 2)}\n`; },

    downloadName(adminFilePath) {
      const base = String(adminFilePath ?? '').split(/[\\/]/).pop();
      return base || 'gateway-admin.json';
    },

    // Why the editor is read-only, naming what is missing; null when changes can be applied.
    readOnlyReason(config, capabilities) {
      const signIn = capabilities?.signIn;
      let derived = null;
      if (signIn?.mode === 'off') derived = 'Sign-in is off. Changing the gateway configuration needs admin sign-in with the AdminUi.Admin role.';
      else if (signIn && signIn.isAdmin === false) derived = 'Your account does not hold the AdminUi.Admin role, which changing the gateway configuration needs.';
      else if (capabilities?.arm && capabilities.arm.writeGateway === false) derived = 'admin-ui has no write access to the gateway app. It needs Container Apps Contributor on the gateway app.';
      if (config?.canWrite === false) return config.readOnlyReason || derived || 'The server reports this configuration as read-only.';
      return derived;
    },

    // Reading needs the same Azure role as saving (containerApps/read and listSecrets), so a missing one explains a failed read.
    loadFailure(message, capabilities) {
      const missing = list(capabilities?.items).find((i) => i?.key === 'arm.writeGateway' && i.granted === false);
      if (!missing) return { title: 'Could not read the gateway configuration', lines: [message], detail: null };
      return {
        title: 'admin-ui cannot read the gateway configuration',
        lines: [`It does not have ${missing.label}, which reading the configuration needs.`, missing.howToGrant].filter(Boolean),
        detail: message,
      };
    },

    dataLossWarning(config) {
      return config?.restart?.temporaryDatabase === true ? (config.restart.warning || DEFAULT_WARNING) : null;
    },

    applyError(status, body) {
      const message = body?.error || `The server answered HTTP ${status}.`;
      if (status === 409 && body?.currentVersion) return { kind: 'conflict', message, currentVersion: body.currentVersion };
      if (status === 428 || body?.requiresAcknowledgement === true) return { kind: 'acknowledge', message };
      if (status === 400) return { kind: 'invalid', message, errors: list(body?.errors) };
      if (status === 403) return { kind: 'forbidden', message };
      return { kind: 'error', message };
    },

    // Saved → new revision → provisioned → running and healthy, from GET /api/gateway-config/rollout.
    rolloutSteps(status) {
      const latest = status?.latestRevision ?? null;
      const started = Boolean(latest) && latest !== (status?.previousRevision ?? null);
      const ready = started && status.latestReadyRevision === latest;
      const provisioned = started && (ready || /^(succeeded|provisioned)$/i.test(status.provisioningState ?? ''));
      const healthy = started && status.done === true && status.failed !== true;
      const health = status?.healthy === true ? 'healthy' : status?.failed ? 'not healthy' : 'not healthy yet';
      const running = [status?.runningStatus, health].filter(Boolean).join(' · ');
      const steps = [
        { label: 'Configuration saved', done: true, detail: '' },
        { label: 'New revision created', done: started, detail: started ? latest : '' },
        { label: 'Revision provisioned', done: provisioned, detail: started ? (status.provisioningState ?? '') : '' },
        { label: 'Running and healthy', done: healthy, detail: provisioned ? running.charAt(0).toUpperCase() + running.slice(1) : '' },
      ];
      let reached = false;
      return steps.map((step) => {
        let state = 'pending';
        if (step.done && !reached) state = 'done';
        else if (!reached) { reached = true; state = status?.failed ? 'failed' : 'current'; }
        return { label: step.label, state, detail: step.detail };
      });
    },

    // The rollout's status line: the server's message as a sentence, or what the page waits for before it has one.
    rolloutMessage(status) {
      const text = String(status?.message ?? '').trim() || 'Waiting for the new revision to be created';
      return text.charAt(0).toUpperCase() + text.slice(1);
    },

    rolloutOutcome(status) {
      if (status?.failed) return 'failed';
      return status?.done ? 'succeeded' : 'running';
    },

    budgetsNote(admin) {
      const n = list(admin?.budgets).length;
      if (!n) return 'The new revision started with an empty database. Spend caps can be set again from the Budgets page.';
      return `The new revision started with an empty database. The admin file lists ${plural(n, 'spend cap', 'spend caps')}; set ${n === 1 ? 'it' : 'them'} again from the Budgets page.`;
    },
  };

  globalThis.configView = configView;
})();
