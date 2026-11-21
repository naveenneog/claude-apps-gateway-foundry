// ADR-0020: presets the Desktop capabilities card offers, so a role gets Claude.ai-like connectors, plugin marketplaces
// and Cowork egress in one click. Loaded as a classic script; tests/admin-config.test.mjs runs every entry through the
// admin-file validator (T-173). Connector URLs were probed on 2026-11-19: each answers an MCP request with 401 and
// OAuth metadata that offers dynamic client registration (Microsoft Learn answers 200 with no sign-in), and none
// redirects, which Desktop requires (https://claude.com/docs/third-party/claude-desktop/extensions.md).
(() => {
  const remote = (name, url, source, note) => ({ entry: { name, transport: 'http', url, oauth: true }, source, note });
  const desktopCatalog = {
    connectors: [
      remote('Atlassian', 'https://mcp.atlassian.com/v2/mcp', 'https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/', 'Jira, Confluence'),
      remote('Notion', 'https://mcp.notion.com/mcp', 'https://developers.notion.com/guides/mcp/overview', 'Pages and databases'),
      remote('Linear', 'https://mcp.linear.app/mcp', 'https://linear.app/docs/mcp', 'Issues and projects'),
      remote('monday.com', 'https://mcp.monday.com/mcp', 'https://developer.monday.com/api-reference/docs/mondaycom-mcp', 'Boards and items'),
      remote('Figma', 'https://mcp.figma.com/mcp', 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/', 'Design files'),
      remote('Canva', 'https://mcp.canva.com/mcp', 'https://www.canva.com/help/mcp-agent-setup/', 'Designs'),
      remote('Sentry', 'https://mcp.sentry.dev/mcp', 'https://mcp.sentry.dev', 'Errors and issues'),
      remote('Stripe', 'https://mcp.stripe.com', 'https://docs.stripe.com/mcp', 'Payments data'),
      remote('Intercom', 'https://mcp.intercom.com/mcp', 'https://developers.intercom.com/docs/guides/mcp', 'Conversations (US region)'),
      remote('Webflow', 'https://mcp.webflow.com/mcp', 'https://developers.webflow.com/mcp/reference/how-it-works', 'Sites and CMS'),
      remote('Vercel', 'https://mcp.vercel.com', 'https://vercel.com/docs/agent-resources/vercel-mcp', 'Projects and deployments'),
      remote('Cloudflare', 'https://mcp.cloudflare.com/mcp', 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/', 'Cloudflare API'),
      remote('Zapier', 'https://mcp.zapier.com/api/mcp/mcp', 'https://docs.zapier.com/mcp/home', 'Actions across apps'),
      { entry: { name: 'Microsoft Learn', transport: 'http', url: 'https://learn.microsoft.com/api/mcp' }, source: 'https://learn.microsoft.com/en-us/training/support/mcp-developer-reference', note: 'Microsoft documentation, no sign-in' },
    ],
    // Anthropic's public marketplaces; the default branch is tracked, so users install plugins themselves.
    marketplaces: [
      { entry: { source: 'github', repo: 'anthropics/claude-plugins-official' }, source: 'https://github.com/anthropics/claude-plugins-official', note: 'Anthropic-managed plugin directory' },
      { entry: { source: 'github', repo: 'anthropics/knowledge-work-plugins' }, source: 'https://github.com/anthropics/knowledge-work-plugins', note: 'Plugins for knowledge work in Cowork' },
      { entry: { source: 'github', repo: 'anthropics/financial-services' }, source: 'https://github.com/anthropics/financial-services', note: 'Financial services plugins' },
    ],
    // Commonly needed hosts for Chat, Cowork and Code's sandbox: package registries, source hosting, Microsoft and Azure,
    // major cloud APIs and documentation. *.name covers subdomains only, so apex hosts are listed too
    // (https://claude.com/docs/third-party/claude-desktop/configuration#coworkegressallowedhosts).
    egressHosts: [
      'pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', '*.yarnpkg.com',
      'crates.io', 'static.crates.io', 'index.crates.io', 'rubygems.org', 'proxy.golang.org', 'sum.golang.org', 'go.dev',
      'repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org', 'api.nuget.org', '*.nuget.org',
      'repo.anaconda.com', 'conda.anaconda.org', 'deb.debian.org', 'security.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com',
      'github.com', '*.github.com', '*.githubusercontent.com', 'ghcr.io', 'gitlab.com', 'bitbucket.org',
      'registry-1.docker.io', 'auth.docker.io', '*.docker.io', 'mcr.microsoft.com', '*.mcr.microsoft.com',
      'microsoft.com', '*.microsoft.com', 'learn.microsoft.com', 'login.microsoftonline.com', 'graph.microsoft.com',
      '*.azure.com', '*.azureedge.net', '*.blob.core.windows.net', '*.office.com', '*.sharepoint.com', 'aka.ms',
      '*.googleapis.com', '*.amazonaws.com',
      'docs.python.org', 'developer.mozilla.org', 'stackoverflow.com', '*.stackexchange.com', 'wikipedia.org', '*.wikipedia.org',
    ],
  };
  globalThis.desktopCatalog = desktopCatalog;
})();
