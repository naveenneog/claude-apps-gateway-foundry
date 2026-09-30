# ADR-0006: Publish a cleaned copy of a committed revision, without history, as the public repository under the guide's name

- **Status:** Accepted
- **Date:** 2026-09-30
- **Packet:** P-31
- **Deciders:** owner, Architect seat

## Context

The owner gave a customer the network-restricted guide (`docs/export/`), whose clone command names
`naveenneog/claude-apps-gateway-foundry`. When this decision was recorded, the repository at that URL was private,
so the command failed for the customer. The owner asked for a clean public repository under that name and allowed
the working repository to stay private.

A read-only scan of the working repository's 66 commits on 2026-09-30 found no credential, subscription ID, tenant ID
or e-mail address, and it found these items that a public repository would expose:

| Item | Where | Handling |
|---|---|---|
| The owner's Windows user name, in local paths and as "Deciders" | 10 files, in HEAD and history | Local paths become permalinks into the public repositories they name, at the commit each local copy held when cited (`claude-code-foundry-gateway` at `f237fb9` and `205a6cc`, `claude-desktop-foundry` at `c2675ff`, `foundry-hackathon-gateway` at `6718c0a`); "Deciders" reads "owner", as in ADR-0005 |
| The tester's egress range | 10 files, among them tests | Replaced by 203.0.113.0/24, the RFC 5737 documentation range, in text and fixtures alike |
| The NAT gateway's public IP address | `docs/learn/media/azure-private/test-vm-overview.png` and the PDF and Word copies | Replaced in the image by 198.51.100.10, an RFC 5737 documentation address, in the portal's font and colour; both copies rebuilt |
| The public test gateway's host name | `docs/STATUS.md`, `docs/learn/how-to-test-inference.md` | Replaced by `<environment>` |
| The tenant's display name and the account's billing state | `docs/STATUS.md` | Removed |
| The APIM gateway's suffix and the Foundry account names | 8 files | Kept as an approved disclosure: they are already public in the owner's repositories `naveenneog/claude-code-foundry-gateway`, `naveenneog/dailyapps-skills` and `naveenneog/NeoFit` (GitHub code search, 2026-09-30), and each endpoint needs an Entra ID token of the tenant |
| The internal gateway's host name and the example deployment's resource names | Tutorial text and screenshots | Kept as an approved disclosure: the host name has no public DNS record and the environment has no public address (T-16); every resource needs an Entra ID token of the tenant |
| Code adapted from the owner's CODEX project | `infra/azure-test/lib/spawn.mjs`, `tests/deploy-spawn.test.mjs` | Kept, with the local path removed from the provenance line; the code is the owner's (U-68) |
| 29 workflow runs and 60 artifacts | GitHub Actions history of the working repository | A new repository has none; the scan of every log and artifact found no address, e-mail or token |

GitHub keeps redirecting a renamed repository's old name to the new one until a repository takes the old name
([renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository), U-66).
Changing a repository from private to public exposes its history and its Actions history
([repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)).
`git push` sends the objects reachable from the refs it pushes, so a branch pushed from a clone of the working
repository would carry that repository's history.

## Options considered
1. **Make the working repository public** — the guide's URL works with no rename, but the history, 29 runs and 60
   artifacts carry every item above.
2. **Clean HEAD, then make the working repository public** — the history still carries the items; removing them means
   rewriting published history, which the charter forbids.
3. **Publish cleaned copies of committed revisions as a new repository under the guide's name, and keep the renamed
   working repository private** — the guide's URL works and the history stays private; each change reaches the public
   repository only through a publication.
4. **Publish one cleaned copy as a new repository under the guide's name, and move all work to it** — no second
   repository to keep in step, but live-run notes written during development would then be public as soon as they
   are pushed, before any review, and the owner asked to keep the working repository private.
5. **Publish under another name** — no rename, but the guide the customer holds names a repository that does not
   exist.

## Decision
Option 3. It makes the guide's clone command work, keeps the history private, and puts a reviewed, scripted step
between the working repository and the public one.

- The working repository becomes `naveenneog/claude-apps-gateway-foundry-private`. The local clone's `origin` moves
  to the new name before the public repository exists, because afterwards the old name reaches the public one (U-66).
- The items above are cleaned at the source, in the working repository, so the two trees hold the same files and a
  publication is a copy, not a transformation.
- `scripts/publish/check-public.mjs` checks a tree: user profile paths, public IPv4 addresses, Container Apps host
  names and e-mail addresses by pattern, and literal text from a deny file kept outside the repository, so the file
  itself publishes nothing. It reads UTF-8 and UTF-16 text, the XML parts and paragraph text of Word files, the text
  chunks of PNG images, and PDFs, which a small tokenizer reads object by object from the `%PDF-` header on, decoding
  the strings and escaped names of the objects and inflating Flate streams. A part that is itself a ZIP, PDF or PNG is
  opened the same way, up to three containers deep, whatever its name. A file counts as a PDF by its `.pdf` name, or by
  a header in its first 1024 bytes together with an object header. The checker exits 2 on a file it cannot read
  completely:
  - a ZIP whose entries disagree with its directory;
  - a PNG chunk other than image data, plain values and text, or data after its last chunk;
  - a PDF construct the tokenizer does not know, an object header anywhere in the file that the tokenizer did not read
    as one (written as leniently as MuPDF and pdf.js accept it), an object or cross-reference stream, encryption, a
    filter other than Flate or an image filter, a Flate predictor, or a `/Length` that is missing, names an object the
    file does not hold or defines twice, does not end at `endstream` or does not match the Flate data;
  - a container nested more than three deep, or a part past `--max-inflated-bytes`.

  Page text is not decoded. A page's content stream gets the deny list over its inflated bytes, which finds text
  written plainly in a font with a standard encoding. A reader also shows text written with escapes or as hexadecimal
  strings, text split across operators or content streams, text whose codes a font's encoding maps to other letters,
  and the glyph codes of embedded fonts. Decoding those as a reader does takes a text-extraction engine, so the
  checker leaves them out, and the table below lists them. The page text of the tracked PDF is built from the
  `docs/learn` articles, which the checker reads as text with every rule.

  Sources: [ISO 32000-1:2008](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf),
  sections 7.2 to 7.5; MuPDF's number lexer,
  [`lex_number` in pdf-lex.c](https://github.com/ArtifexSoftware/mupdf/blob/master/source/pdf/pdf-lex.c); pdf.js,
  [`indexObjects` and `fetchUncompressed` in xref.js](https://github.com/mozilla/pdf.js/blob/master/src/core/xref.js);
  [PNG, third edition](https://www.w3.org/TR/png-3/), section 11.
  `scripts/publish/allow.json` lists each accepted value with a `why`; an entry without one, or an address range
  wider than /16, passes nothing. The checker's test runs it over the tracked files, so CI fails when a commit adds
  such a value.
- `scripts/publish/publish-public.mjs` publishes one committed revision as one commit and fails closed (T-77). It
  refuses a clone of the public repository whose `origin` fetches from or pushes to anything but the public URL, that
  has uncommitted changes, whose effective author or committer (`git var`) is not a GitHub no-reply address, or that
  holds any commit of the working repository in any ref. It fetches origin's `main`, and the clone's `main` has to be
  that commit, or a publication of the same revision prepared on it and not yet pushed. It writes the revision's
  files from git's object store, executable bits included where the file system holds them, refusing any path that
  leaves the folder, reaches `.git` or collides with another, runs the checker with the deny file, replaces every file
  of the clone but `.git`, sets each file's mode in the index from the revision, and requires the staged tree to
  equal the revision's tree. The commit is written with `git commit-tree` from that tree with origin's `main` as its
  only parent and checked before `main` moves; with `--push`, exactly that commit is pushed to `main`, without tags.
  No hook of the clone runs.
- `scripts/publish/verify-public.mjs` checks the result as a reader without credentials does (T-76): it accepts an
  HTTPS URL without credentials, sends the anonymous smart-HTTP request git sends first, and mirrors the repository
  with no git configuration or git, credential or SSH environment variable of the operator. It checks that no ref
  reaches a commit of the working repository, that every commit on `main` is a publication by no-reply identities,
  that `main` holds the published revision's tree, and only then exports it for the checker.
- Each public commit's message names its source revision and tree, and `docs/STATUS.md` records the pair.
- The public repository is under the MIT license the owner chose.

A publication, from the working repository's root with the deny file outside it:

```powershell
git clone https://github.com/naveenneog/claude-apps-gateway-foundry.git <public clone>   # once; the script fetches origin's main itself
node scripts/publish/publish-public.mjs --public-dir <public clone> --public-url https://github.com/naveenneog/claude-apps-gateway-foundry.git --deny-file <deny file> --push
node scripts/publish/verify-public.mjs --public-url https://github.com/naveenneog/claude-apps-gateway-foundry.git --deny-file <deny file>
```

What each check covers:

| Check | Covers | Does not cover |
|---|---|---|
| The checker's test in CI | The patterns, over every tracked file | The deny list, which stays outside the repository |
| `publish-public.mjs` | The patterns over text, Word parts, PDF object strings and PNG text chunks; the deny list over those and over the bytes of every file and part, PDF Flate streams included, which finds page text written plainly; the commit's parent, tree and identities | Text drawn in images; PDF page text written with escapes or hexadecimal strings, split across operators or content streams, remapped by a font's encoding, or written as glyph codes of embedded fonts; compressed data inside other binary formats (none is tracked) |
| `verify-public.mjs` | What a reader without credentials receives: every ref, every commit on `main`, the files of `main` | The same as `publish-public.mjs` |
| A person, before publishing | Changed screenshots, and the rebuilt PDF and Word copies, whose page text the checker does not decode | — |

Issues and pull requests opened on the public repository are read and answered there. A change they ask for is made
in the working repository and arrives with the next publication; a pull request is not merged on GitHub, since the
next publication would replace its files.

## Consequences
+ The guide's `git clone` command works for anyone, and CI runs on the public repository's GitHub-hosted runners.
+ A leak of the working repository's history into the public one is refused before the push and detected after it.
+ The checker's test fails CI on a new user profile path, public address, Container Apps host or e-mail address.
− Two repositories: a change reaches the public one only when someone publishes it.
− The rename redirect ends when the public repository takes the name: a clone elsewhere that still points at the old
  name pushes to the public repository. A branch pushed from such a clone would publish the private history;
  `verify-public.mjs` detects it. Deleting the branch leaves its commits reachable by SHA in GitHub's cached views
  until GitHub Support removes them, and clones or forks made meanwhile keep them
  ([removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)).
− The checker finds values by pattern and by the deny file; a new kind of value, such as a key ID or a resource name,
  passes unless someone adds it, and it does not read text drawn in images.

## How we'd know this was wrong
- The public repository holds a commit of the working repository, or a value the table marks as removed (T-76).
- A customer cannot follow the guide from the public repository: a file the guide names is missing, or a test fails
  on the clone (T-76).
- Changes are made in the public repository that the working repository does not have, or reviewed changes wait
  longer than a working week for a publication: then option 4 costs less than keeping two repositories in step.
- The owner's organisation requires another release path for this content.
