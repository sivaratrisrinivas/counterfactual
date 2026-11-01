# Domain docs

This repo uses a single-context layout:
root `GLOSSARY.md` and `docs/adr/`.

## Before exploring

Read `GLOSSARY.md` and ADRs relevant to the area being explored.

If `GLOSSARY-MAP.md` exists, follow its pointers and read the glossaries
relevant to the topic. Also check context-specific ADR directories.

If these files do not exist, proceed silently. Do not flag their absence
or suggest creating them upfront. The domain-modeling skill creates
them as terms and decisions are resolved.

## Use the glossary's vocabulary

Use glossary terms when naming domain concepts in issues, proposals,
hypotheses, and tests. Avoid synonyms the glossary explicitly rejects.

If a concept is missing, reconsider whether it belongs to the project.
Record real vocabulary gaps for domain-modeling.

## Flag ADR conflicts

Explicitly identify any proposal that contradicts an existing ADR.
Name the ADR and explain why its decision should be reconsidered.
