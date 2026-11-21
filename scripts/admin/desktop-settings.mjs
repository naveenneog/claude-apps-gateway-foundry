// Per-role Claude Desktop settings for the admin file (T-122, P-40; T-167, ADR-0019; T-171, ADR-0020): validation and
// the policy's rendered desktop block. The gateway serves the block from /user/bootstrap; Desktop applies bootstrap
// values over local settings and makes them read-only (https://claude.com/docs/third-party/claude-desktop/configuration).
export const DESKTOP_SETTINGS = [
  'chatTabEnabled', 'coworkTabEnabled', 'isClaudeCodeForDesktopEnabled',
  'userPluginMarketplacesEnabled', 'userPluginUploadsEnabled', 'skillCreationEnabled', 'isDesktopExtensionEnabled',
  'isDesktopExtensionSignatureRequired', 'isLocalDevMcpEnabled',
];
const IMPORT_SETTINGS = ['enabled', 'exportEnabled'];
// ADR-0020: structured keys, each rendered as one JSON flow value with its fields in this order. Fields Desktop marks
// "Consent required" for bootstrap delivery, and any secret or command, are not accepted.
export const STRUCTURED_SETTINGS = ['managedMcpServers', 'allowedPluginMarketplaces', 'allowedPluginMcpServers', 'deniedPluginMcpServers', 'coworkEgressAllowedHosts'];
// defaultState is documented by Desktop, but the deployed gateway image (Claude Code 2.1.311) refuses it at boot as an
// unrecognized sub-key; new sub-keys need 2.1.321 (U-151, T-181). It is refused until the image moves.
const CONNECTOR_FIELDS = ['name', 'transport', 'url', 'oauth', 'toolTimeoutSec', 'toolPolicy'];
// Desktop's bundled connectors that need only IDs (no secret, no "Consent required" field).
const BUILTIN_FIELDS = {
  microsoft365: ['name', 'server', 'tenantId', 'clientId', 'azureCloud', 'scope', 'toolPolicy'],
  github: ['name', 'server', 'clientId', 'host', 'scope', 'toolsets', 'readOnly', 'toolPolicy'],
};
// coworkEgressAllowedHosts entries: a host name, a *.wildcard (subdomains only) or * for all, with an optional :port.
const HOST = /^(\*|(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?)$/i;
const MARKETPLACE_FIELDS = ['source', 'repo', 'url', 'ref', 'path', 'expectedName', 'manifestSha256', 'installationPreference'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const TOOL = /^[A-Za-z0-9_.*-]{1,128}$/;
const MAX_ITEMS = 50;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// The gateway expands ${VAR} in any string (scripts/admin/new-gateway-config.mjs, scalar), and the value reaches every user.
const plain = (v, max = 2048) => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\x00-\x1f\x7f$]/.test(v);
const https = (v) => plain(v) && /^https:\/\/[^\s/]+/i.test(v);

function unknownFields(entry, allowed, at, errors) {
  for (const key of Object.keys(entry)) if (!allowed.includes(key) && key !== 'defaultState') errors.push(`${at}.${key}: not supported here (ADR-0020); set it through device management`);
}

function listOf(value, at, errors) {
  if (!Array.isArray(value)) { errors.push(`${at}: must be a list`); return []; }
  if (value.length > MAX_ITEMS) errors.push(`${at}: at most ${MAX_ITEMS} entries`);
  return value;
}

function toolPolicyErrors(entry, here, errors) {
  if (entry.toolPolicy === undefined) return;
  if (!isObject(entry.toolPolicy)) { errors.push(`${here}.toolPolicy: must be an object of tool name to allow, ask or blocked`); return; }
  for (const [tool, rule] of Object.entries(entry.toolPolicy)) {
    if (!TOOL.test(tool)) errors.push(`${here}.toolPolicy: ${JSON.stringify(tool)} is not a tool name or * pattern`);
    else if (!['allow', 'ask', 'blocked'].includes(rule)) errors.push(`${here}.toolPolicy.${tool}: must be allow, ask or blocked`);
  }
}

// Own keys only: a prototype name such as "constructor", or a non-string, is not a built-in server.
const builtinFieldsOf = (server) => (typeof server === 'string' && Object.hasOwn(BUILTIN_FIELDS, server) ? BUILTIN_FIELDS[server] : null);

function builtinErrors(entry, here, errors) {
  const fields = builtinFieldsOf(entry.server);
  if (!fields) { errors.push(`${here}.server: must be microsoft365 or github; other built-in servers need device management`); return; }
  for (const key of Object.keys(entry)) {
    if (key === 'transport' || key === 'url') errors.push(`${here}.${key}: not used with a built-in server`);
    else if (!fields.includes(key) && key !== 'defaultState') errors.push(`${here}.${key}: not supported here (ADR-0020); set it through device management`);
  }
  if (entry.server === 'microsoft365') {
    if (!UUID.test(String(entry.tenantId ?? ''))) errors.push(`${here}.tenantId: must be a directory (tenant) ID`);
    if (!UUID.test(String(entry.clientId ?? ''))) errors.push(`${here}.clientId: must be the application (client) ID of your app registration`);
    if (entry.azureCloud !== undefined && !['global', 'us-gov-high', 'us-gov-dod'].includes(entry.azureCloud)) errors.push(`${here}.azureCloud: must be global, us-gov-high or us-gov-dod`);
  } else {
    if (!plain(entry.clientId, 100) || !/^[A-Za-z0-9._-]+$/.test(entry.clientId)) errors.push(`${here}.clientId: must be the GitHub OAuth or GitHub App client ID`);
    if (entry.host !== undefined && !https(entry.host)) errors.push(`${here}.host: must be an https:// address`);
    if (entry.toolsets !== undefined && !plain(entry.toolsets, 500)) errors.push(`${here}.toolsets: must be comma-separated toolset names`);
    if (entry.readOnly !== undefined && typeof entry.readOnly !== 'boolean') errors.push(`${here}.readOnly: must be true or false`);
  }
  if (entry.scope !== undefined && !plain(entry.scope, 1000)) errors.push(`${here}.scope: must be 1 to 1000 characters without control characters or $`);
}

// ADR-0020 amendment 2: "Bring your own client" with a public client ID, for servers without dynamic client
// registration (Salesforce's hosted MCP). No secret or secret helper: either would reach every user of the role.
const OAUTH_FIELDS = ['mode', 'clientId', 'scope', 'appendOfflineAccess'];
function oauthErrors(oauth, here, errors) {
  if (!isObject(oauth)) { errors.push(`${here}: must be true (automatic client registration) or a public client object {clientId, scope}`); return; }
  unknownFields(oauth, OAUTH_FIELDS, here, errors);
  if (oauth.mode !== undefined && oauth.mode !== 'byo') errors.push(`${here}.mode: must be byo (Bring your own client); other modes need device management`);
  if (oauth.clientId === undefined) errors.push(`${here}.clientId: required for a public client; use oauth: true for automatic registration`);
  else if (!plain(oauth.clientId, 256) || !/^[A-Za-z0-9._:-]+$/.test(oauth.clientId)) errors.push(`${here}.clientId: must be the OAuth client ID (letters, digits, . _ : -)`);
  if (oauth.scope !== undefined && !plain(oauth.scope, 1000)) errors.push(`${here}.scope: must be 1 to 1000 characters without control characters or $`);
  if (oauth.appendOfflineAccess !== undefined && typeof oauth.appendOfflineAccess !== 'boolean') errors.push(`${here}.appendOfflineAccess: must be true or false`);
}

function connectorErrors(value, at) {
  const errors = [];
  const names = new Set();
  listOf(value, at, errors).forEach((entry, n) => {
    const here = `${at}[${n}]`;
    if (!isObject(entry)) { errors.push(`${here}: must be an object`); return; }
    if (!plain(entry.name, 64)) errors.push(`${here}.name: must be 1 to 64 characters without control characters or $`);
    else if (names.has(entry.name)) errors.push(`${at}: ${entry.name} is listed twice`);
    else names.add(entry.name);
    if (entry.defaultState !== undefined) errors.push(`${here}.defaultState: the gateway image (Claude Code 2.1.311) refuses it at boot; it needs 2.1.321 or later (U-151). Leave it out: connectors start on`);
    toolPolicyErrors(entry, here, errors);
    if (entry.server !== undefined) { builtinErrors(entry, here, errors); return; }
    unknownFields(entry, CONNECTOR_FIELDS, here, errors);
    if (!['http', 'sse'].includes(entry.transport)) errors.push(`${here}.transport: must be http or sse; local (stdio) servers need device management`);
    if (!https(entry.url)) errors.push(`${here}.url: must be an https:// address without control characters or $`);
    if (entry.oauth !== undefined && entry.oauth !== true) oauthErrors(entry.oauth, `${here}.oauth`, errors);
    if (entry.toolTimeoutSec !== undefined && !(Number.isInteger(entry.toolTimeoutSec) && entry.toolTimeoutSec >= 5 && entry.toolTimeoutSec <= 3600)) {
      errors.push(`${here}.toolTimeoutSec: must be a whole number from 5 to 3600`);
    }
  });
  return errors;
}

function hostErrors(value, at) {
  if (!Array.isArray(value)) return [`${at}: must be a list`];
  const errors = value.length > 500 ? [`${at}: at most 500 entries`] : [];
  for (const host of value) if (typeof host !== 'string' || !HOST.test(host)) errors.push(`${at}: ${JSON.stringify(host)} is not a host name, *.wildcard or *`);
  return errors;
}

function marketplaceErrors(value, at) {
  const errors = [];
  listOf(value, at, errors).forEach((entry, n) => {
    const here = `${at}[${n}]`;
    if (!isObject(entry)) { errors.push(`${here}: must be an object`); return; }
    unknownFields(entry, MARKETPLACE_FIELDS, here, errors);
    if (!['github', 'git', 'url'].includes(entry.source)) { errors.push(`${here}.source: must be github, git or url`); return; }
    if (entry.source === 'github') {
      if (typeof entry.repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(entry.repo)) errors.push(`${here}.repo: must be owner/name`);
      if (entry.url !== undefined) errors.push(`${here}.url: not used with source github`);
    } else {
      if (!https(entry.url)) errors.push(`${here}.url: must be an https:// address without control characters or $`);
      if (entry.repo !== undefined) errors.push(`${here}.repo: used only with source github`);
    }
    for (const key of ['ref', 'path', 'expectedName']) if (entry[key] !== undefined && !plain(entry[key], 200)) errors.push(`${here}.${key}: must be 1 to 200 characters without control characters or $`);
    if (entry.manifestSha256 !== undefined && !SHA256.test(String(entry.manifestSha256))) errors.push(`${here}.manifestSha256: must be a 64-character SHA-256 hex value`);
    const pref = entry.installationPreference;
    if (pref !== undefined && !['available', 'auto_install', 'required'].includes(pref)) errors.push(`${here}.installationPreference: must be available, auto_install or required`);
    if (pref === 'auto_install' || pref === 'required') {
      if (entry.source === 'url' ? !SHA256.test(String(entry.manifestSha256 ?? '')) : !SHA1.test(String(entry.ref ?? ''))) {
        errors.push(entry.source === 'url'
          ? `${here}: installationPreference ${pref} needs manifestSha256 for a url source`
          : `${here}.ref: auto_install and required need a 40-character commit SHA`);
      }
    }
  });
  return errors;
}

function serverUrlErrors(value, at) {
  const errors = [];
  listOf(value, at, errors).forEach((entry, n) => {
    const here = `${at}[${n}]`;
    if (!isObject(entry)) { errors.push(`${here}: must be an object with serverUrl`); return; }
    unknownFields(entry, ['serverUrl'], here, errors);
    if (!plain(entry.serverUrl, 500) || !/^https:\/\//i.test(entry.serverUrl)) errors.push(`${here}.serverUrl: must start with https:// and hold no control characters or $`);
  });
  return errors;
}

export function desktopErrors(policy, i) {
  const errors = policy.desktop !== undefined && typeof policy.desktop !== 'boolean' ? [`policies[${i}].desktop: must be true or false`] : [];
  const settings = policy.desktopSettings;
  if (settings === undefined) return errors;
  if (!isObject(settings)) return [...errors, `policies[${i}].desktopSettings: must be an object`];
  const at = (key) => `policies[${i}].desktopSettings.${key}`;
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'claudeAiImport') {
      if (!isObject(value)) { errors.push(`${at(key)}: must be an object`); continue; }
      for (const [name, on] of Object.entries(value)) {
        if (name === 'allowedOrganizationUuids') {
          if (!Array.isArray(value[name])) errors.push(`${at(key)}.allowedOrganizationUuids: must be a list of UUIDs`);
          else for (const id of value[name]) if (typeof id !== 'string' || !UUID.test(id)) errors.push(`${at(key)}.allowedOrganizationUuids: ${id} is not a UUID`);
        } else if (!IMPORT_SETTINGS.includes(name)) errors.push(`${at(key)}.${name}: not a supported import setting`);
        else if (typeof on !== 'boolean') errors.push(`${at(key)}.${name}: must be true or false`);
      }
    } else if (key === 'managedMcpServers') errors.push(...connectorErrors(value, at(key)));
    else if (key === 'allowedPluginMarketplaces') errors.push(...marketplaceErrors(value, at(key)));
    else if (key === 'allowedPluginMcpServers' || key === 'deniedPluginMcpServers') errors.push(...serverUrlErrors(value, at(key)));
    else if (key === 'coworkEgressAllowedHosts') errors.push(...hostErrors(value, at(key)));
    else if (!DESKTOP_SETTINGS.includes(key)) errors.push(`${at(key)}: not a supported Claude Desktop setting (${[...DESKTOP_SETTINGS, ...STRUCTURED_SETTINGS].join(', ')}, claudeAiImport)`);
    else if (typeof value !== 'boolean') errors.push(`${at(key)}: must be true or false`);
  }
  return errors;
}

// Fields in a fixed order, so the same meaning renders the same gateway.yaml text whatever the admin file's order.
const ordered = (entry, fields) => Object.fromEntries(fields.filter((f) => entry[f] !== undefined).map((f) => [f, entry[f]]));
const RENDER = {
  managedMcpServers: (list) => list.map((e) => {
    const fields = e.server !== undefined ? builtinFieldsOf(e.server) : CONNECTOR_FIELDS;
    return { ...ordered(e, fields), ...(isObject(e.oauth) ? { oauth: ordered(e.oauth, OAUTH_FIELDS) } : {}), ...(e.toolPolicy ? { toolPolicy: { ...e.toolPolicy } } : {}) };
  }),
  allowedPluginMarketplaces: (list) => list.map((e) => ordered(e, MARKETPLACE_FIELDS)),
  allowedPluginMcpServers: (list) => list.map((e) => ({ serverUrl: e.serverUrl })),
  deniedPluginMcpServers: (list) => list.map((e) => ({ serverUrl: e.serverUrl })),
  coworkEgressAllowedHosts: (list) => [...list],
};

// The desktop block of a policy: the empty opt-in, or the opt-in with Desktop's settings. JSON is YAML 1.2 flow syntax.
export const desktopBlock = (settings) => {
  const keys = DESKTOP_SETTINGS.filter((k) => typeof settings?.[k] === 'boolean');
  const structured = STRUCTURED_SETTINGS.filter((k) => Array.isArray(settings?.[k]));
  const imports = IMPORT_SETTINGS.filter((k) => typeof settings?.claudeAiImport?.[k] === 'boolean');
  const orgs = Array.isArray(settings?.claudeAiImport?.allowedOrganizationUuids) ? settings.claudeAiImport.allowedOrganizationUuids : null;
  if (!keys.length && !structured.length && !imports.length && !orgs) return ['      desktop: {}'];
  return [
    '      desktop:', ...keys.map((k) => `        ${k}: ${settings[k]}`),
    ...structured.map((k) => `        ${k}: ${JSON.stringify(RENDER[k](settings[k]))}`),
    ...(imports.length || orgs ? ['        claudeAiImport:', ...imports.map((k) => `          ${k}: ${settings.claudeAiImport[k]}`),
      ...(orgs ? [`          allowedOrganizationUuids: ${JSON.stringify(orgs)}`] : [])] : []),
  ];
};

// Whether a policy opts in to Claude Desktop: its own desktop wins; absent, deployment.desktop's default applies.
export const desktopOfFor = (deployment) => (p) => (p.desktop !== undefined ? p.desktop === true : deployment?.desktop === true);
