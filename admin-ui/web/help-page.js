// The Help page (P-41): the administrator's tasks from help-topics.js, each with its steps in the console's own labels
// and a link to the article in the public repository, plus where to look when something fails.
const helpPage = (() => {
  const DOCS = 'https://github.com/naveenneog/claude-apps-gateway-foundry/blob/main/';
  const DESCRIPTION = 'How to do each administrator task in this console, and where the full guide is.';

  function topicCard(t) {
    return el('details', { class: 'help-topic card', id: `help-${t.id}` }, [
      el('summary', {}, [el('strong', { text: t.title }), el('span', { class: 'help-when', text: t.when })]),
      el('div', { class: 'card-body stack' }, [
        el('ol', { class: 'help-steps' }, t.steps.map((s) => el('li', { text: s }))),
        el('a', { href: `${DOCS}${t.doc}`, target: '_blank', rel: 'noopener', class: 'inline-link', text: 'Read the full guide' }),
      ]),
    ]);
  }

  function render(ctx) {
    const links = [
      ['Start here: install and onboard developers', 'docs/learn/tutorial-first-install.md'],
      ['Use the admin console: every page', 'docs/learn/how-to-use-admin-console.md'],
      ['Troubleshooting: messages and what to do', 'docs/learn/troubleshoot.md'],
      ['Glossary: the terms these pages use', 'docs/learn/glossary.md'],
    ];
    ctx.root.replaceChildren(
      ui.pageHeader({ title: 'Help', description: DESCRIPTION }),
      el('div', { class: 'stack help-topics' }, helpTopics.map(topicCard)),
      ui.card({ title: 'Guides', description: 'The documentation in the gateway repository, written for a first-time administrator.', content: el('div', { class: 'card-body' }, [
        el('ul', { class: 'help-links' }, [
          ...links.map(([text, doc]) => el('li', {}, [el('a', { href: `${DOCS}${doc}`, target: '_blank', rel: 'noopener', class: 'inline-link', text })])),
          el('li', {}, [el('a', { href: 'https://code.claude.com/docs/en/claude-apps-gateway', target: '_blank', rel: 'noopener', class: 'inline-link', text: 'Claude apps gateway documentation (Anthropic)' })]),
        ]),
      ]) }),
    );
  }

  return { title: 'Help', render };
})();
