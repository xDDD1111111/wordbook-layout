# Wordbook Layout

Wordbook Layout arranges heading-based vocabulary lists into a clean, responsive reading layout in Obsidian. It uses two columns on wider screens and one column on phones and narrow panes.

## Features

- Groups note content by the highest-level headings in the note.
- Uses a two-column layout on desktop and a single-column layout on mobile.
- Keeps task checkboxes interactive and writes their state back to Markdown.
- Works with Obsidian's page search in the generated reading layout.
- Uses only Obsidian APIs and supports desktop, Android, iPhone, and iPad.
- Stores no separate database and makes no network requests.

## Usage

Open a Markdown note and run **Toggle wordbook layout for the current note** from the command palette. The command adds this property:

```yaml
---
wordbook-layout: true
---
```

Switch the note to Reading view. Each top-level section is displayed as a wordbook card. Run the command again to restore the normal layout.

For compatibility with earlier personal versions, the plugin also recognizes the property `单词书布局: true`.

## Example

```markdown
---
wordbook-layout: true
---

## List 01

1. [ ] vocabulary
2. [x] example

## List 02

1. [ ] responsive
2. [ ] layout
```

## Mobile

The layout automatically changes to one column below 760 pixels. The plugin does not use Node.js, Electron, or desktop-only filesystem APIs.

## License

[MIT](LICENSE)
