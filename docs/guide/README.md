# User guide sources

Markdown for the pilot-facing OpenVFR guide. The website build pulls this
folder in and renders it; the files are also readable as-is on GitHub.

## Rules for pages

- Every page starts with frontmatter: `title`, `description`, and
  `sidebar.order` (the sidebar is generated from the folder, so a new page
  needs no change elsewhere).
- Do not repeat the page title as a `# Heading`: the site renders `title`.
- Links to other guide pages are relative (`./planning-a-route.md`).
  Images live next to the page that uses them.
- Describe what the app does for the pilot. Developer detail (file paths,
  code names, data-pipeline steps) belongs in `docs/architecture.md` or
  `docs/self-hosting.md`, not here.
- A user-visible change updates the matching page in the same PR.
