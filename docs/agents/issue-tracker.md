# Issue tracker: GitHub

Issues and specs live in GitHub Issues for
`sivaratrisrinivas/counterfactual`. Use the `gh` CLI from this clone.

## Conventions

- Create: `gh issue create --title "..." --body-file <path>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body-file <path>`
- Add labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

For multiline bodies, write the text to a temporary file and use
`--body-file`. Fetch labels when needed with
`gh issue view <number> --json number,title,body,labels,comments`.

Infer the repository from the Git remote.

## Pull requests as a triage surface

PRs as a request surface: no.

## Publishing and fetching tickets

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.

## Wayfinding operations

- Keep the map in one issue labelled `wayfinder:map`, with Notes,
  Decisions-so-far, and Fog sections.
- Link child tickets as GitHub sub-issues. If unavailable, use a task
  list in the map and add `Part of #<map>` to each child.
- Use `wayfinder:<type>` labels for research, prototype, grilling,
  or task tickets.
- Record blockers with native GitHub issue dependencies. If unavailable,
  put `Blocked by: #<number>` at the top of the child.
- Select the first open child in map order with no open blockers
  and no assignee.
- Claim with `gh issue edit <number> --add-assignee @me`.
- Resolve by commenting with the answer, closing the ticket, and adding
  a brief finding and ticket link to the map's Decisions-so-far.
