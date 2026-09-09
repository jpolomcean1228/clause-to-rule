# Pushing this to GitHub

The repo is already initialized with one commit on `main`. From the unzipped folder:

```bash
gh repo create clause-to-rule --public --source=. --push \
  --description "Drafts compliance rules from investment mandate documents, with a human review gate. Prototype for client onboarding in asset and wealth management."
```

Without the `gh` CLI, create an empty repo named `clause-to-rule` on GitHub, then:

```bash
git remote add origin git@github.com:<your-username>/clause-to-rule.git
git push -u origin main
```

## Repo settings worth doing

**Description**
> Drafts compliance rules from investment mandate documents, with a human review gate. Prototype for client onboarding in asset and wealth management.

**Topics**
`llm` `compliance` `asset-management` `human-in-the-loop` `document-extraction` `regtech` `fintech`

**Enable GitHub Pages** (Settings → Pages → Deploy from branch → `main` / root) so the console is a live link
rather than a clone-and-open. Viewers will need to supply their own API key, which the README already covers.

## Renaming

If you'd rather call it something else, the name is only in the folder and the remote — nothing in the code
depends on it. Rename the folder, then `gh repo rename <new-name>`.
