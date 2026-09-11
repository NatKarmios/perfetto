# Working on DuneGraph

Read this before changing anything in this directory. It is short on purpose;
the substance is in the three documents it points at.

## The three documents, and which is which

| File                               | Holds                                                                                                                                                       | Read it when                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [README.md](README.md)             | Using the plugin: recording a trace, what the surfaces show, the load setting, the `dune_*` SQL surface, the limits and traps a user meets.                 | You are changing anything a user sees, types or queries.                              |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it is built and why: the layer table, the graph model, the blob format, the SQL mirror's shape, the Explorer pane, the measurements behind every limit. | Before touching the code. Start with "Layout".                                        |
| [UPSTREAM.md](UPSTREAM.md)         | What the plugin needed from the rest of the UI, commit by commit, and the state of the topic branches carrying it.                                          | You are changing something outside this directory, or splitting branches to upstream. |

**Keep them current in the same change that makes them wrong.** A doc updated
"later" is a doc that is wrong for however long later takes, and these three are
the only places most of this reasoning exists.

Concretely:

- Change what a user sees, a setting's name or default, the SQL surface, or a
  cap they can hit → **README.md**.
- Change a layer, a table's shape, an algorithm, or a number a measurement
  produced → **ARCHITECTURE.md**. Re-measure rather than estimating: the figures
  there are browser figures on a named trace, and a guessed one is worse than
  none.
- Touch a file outside this directory → **UPSTREAM.md**, with why the plugin
  needed it.
- Add or drop a test file, or change the count → the tally in ARCHITECTURE.md's
  "Testing".

## Point at them rather than repeating them

The comments here are deliberately thin, and that is maintained work: a
duplicate paragraph in a comment is one that will disagree with the document
later. So a comment that would explain a whole subsystem cites the section
instead, in this exact form:

```ts
// **ARCHITECTURE.md, "The Explorer pane", is the design** - the two source
// shapes, why counts and members are bounded differently, and what
// `DirExplorerSource` asks an implementation to promise.
```

`docs_unittest.ts` checks every one of those pointers resolves to a real
heading, and that neither document has a dangling `#anchor`. **Renaming a
heading breaks the build**, which is the point — rename it and fix the pointers
in the same change.

What still belongs in a comment is what a reader _of that file_ needs and cannot
get from the document: a measured constant and how it was measured, a trap in
the code as written, an invariant the next edit could break. Those are worth
their lines. Restating the architecture is not.

## Before you finish

From the repo root:

```sh
ui/node_modules/.bin/tsc -p ui/tsconfig.json --noEmit
ui/node_modules/.bin/vitest run src/plugins/com.karmios.nat.DuneGraph --config ui/vitest.config.mjs
cd ui && node_modules/.bin/eslint src/plugins/com.karmios.nat.DuneGraph
cd ui && node_modules/.bin/prettier --check src/plugins/com.karmios.nat.DuneGraph
```

All four, and `prettier --write` rather than hand-wrapping. Two of the tests are
structural rather than behavioural and are the ones most likely to catch you:
`layering_unittest.ts` fails on an import that points up a layer, and
`docs_unittest.ts` fails on a doc pointer that no longer resolves.

There is no trace processor in a unit test, so SQL is tested by asserting on the
strings the builders generate. If you change a query, change the test that
captures it — a query only a browser has ever run is untested.

## Where changes land

Upstream is <https://github.com/google/perfetto>. This plugin's own directory is
self-contained; everything else it needed is in UPSTREAM.md, as one-commit topic
branches off `main`. See the repo root's `CLAUDE.md` for the branch and
commit-message conventions, and `docs/AGENTS-ui.md` for the UI's own.
