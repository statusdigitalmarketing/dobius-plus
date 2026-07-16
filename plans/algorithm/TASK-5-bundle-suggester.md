# TASK-5 — Bundle suggester: cross-document term clustering

**Verdict:** KEEP (Carson: "real logic… put words together across multiple
documents and find relative information… bundle it up in a folder").

## What
A pure main-process module that reads the indexed corpus (names, paths, mail
snippets), finds distinctive shared terms, clusters documents that share them,
and returns suggested bundles. Surfaced in the Manager rail as a "Bundles"
section; a bundle can be filed to a project in one action (bulk classify),
which is the "put it in a folder" step — suggestions become real filing.

## Concrete simplification chosen
Rung: **minimum code, no new dependency.** Deterministic term math over text
the index already holds:
- tokenize name+path+snippet, lowercase, strip stopwords/short tokens
- document frequency per term; a term is a bundle seed if it appears in >= 3
  docs but <= 30% of the corpus (distinctive, not universal)
- merge bundles whose member overlap (Jaccard) >= 0.5; label = top terms
- cap ~20 bundles, largest first
No Drive content downloads, no embeddings, no LLM calls (see DECISIONS.md).

## Acceptance test
- Vitest: a corpus with two obvious topics ("invoice…" docs + "roadmap…" docs)
  yields two bundles with the right members; a universal term ("the",
  account email) never becomes a bundle; overlapping bundles merge.
- Live: rail shows Bundles with counts; clicking scopes the list; "file bundle
  to project" sets project on every member (visible in By-project view).

## Estimate (rough — not measured)
~0.5–1 day including tests and rail UI.
