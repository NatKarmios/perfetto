# What DuneGraph needed from outside its own directory

This plugin is not self-contained. Making it work meant changing the Data
Explorer, the DataGrid, the query page and a couple of widgets — 32 commits on
`main..dune-graph-trace`, and a net footprint of **52 files, +4,889/−1,398**
(measured 2026-09-16, excluding the plugin directory itself).

This file is the ledger. It exists for one reason: in six months the _diff_ will
still be readable and the _motivation_ will not.

Every change here is upstreamable and intended to be upstreamed, with three
explicit exceptions marked below.

## The one dependency

`ui/package.json` and `ui/pnpm-lock.yaml` gain `@hpcc-js/wasm-graphviz`. It is
the first dependency this plugin has asked for, and the one change in this
ledger that is **not** upstreamable as it stands, so it is worth being explicit
about what it means:

- The UI bundles as a single IIFE with no code splitting, so a dependency added
  for an optional plugin ships to every ui.perfetto.dev user whether or not the
  plugin is enabled. It costs ~800 KB of the frontend bundle.
- The npm wrapper is Apache-2.0, but **Graphviz itself is EPL-1.0** — the same
  licence family that ruled out elkjs (EPL-2.0 OR GPL-3.0-or-later). That is a
  question for whoever owns licence policy, not a code review question, and it
  is the main reason this is a spike rather than a proposal.
- The wasm is embedded in the package's own `index.js`, so nothing is fetched at
  runtime and the CSP is not involved. Verified against the built bundle.

Nothing on `dune-graph-trace` depends on it: the hand-rolled layout in
`views/graph_layout.ts` is a complete answer on its own, and is what the pane
uses whenever graphviz is absent, still loading, or too expensive for the graph
in hand.

## Where the changes land

| Area                                  | Roughly                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `plugins/dev.perfetto.DataExplorer`   | the bulk — dashboards, the chart-type registry, brush filters                                  |
| `components/widgets/datagrid`         | metadata-driven cell renderers                                                                 |
| `components/query_table`              | the table list, tab persistence, the SQL formatter (all moved _into_ here from the query page) |
| `plugins/dev.perfetto.QueryPage`      | the other half of those moves                                                                  |
| `bigtrace/pages`, `widgets/grid.scss` | one-line follow-ons                                                                            |
| `core/embedder`                       | the temporary enable and the local plugin-list trim, neither of which must be upstreamed       |

## The ledger

Ordered oldest-first, as they land on the integration line.

### Dashboards and the grid

| Commit                                                   | Branch                                                                               | Why the plugin needed it                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9c49457157` add a grid item to Data Explorer dashboards | `data-explorer-dashboard-grid`                                                       | A dashboard could hold charts but not a plain table of rows. The plugin's whole hand-off story is "put this query somewhere you can read it", which needs a grid.         |
| `5280bf7452` write the grid key's separators as escapes  | none — **squash into the above**                                                     | A fixup to `9c49457157`: raw separator bytes in a grid key.                                                                                                               |
| `b8abfef93f` drop tree mode from dashboard grids         | none — **mixed commit**; the upstream half belongs in `data-explorer-dashboard-grid` | Tree mode on a dashboard grid was unreachable state that the grid item above had to keep working.                                                                         |
| `a72b16431d` recover the dashboards after a cleanup      | `dashboard-recover-after-cleanup`                                                    | Closing a tab tore down tables a still-open dashboard was reading, so a dashboard came back empty.                                                                        |
| `bdb48acfcc` invalidate only the closing tab's tables    | `dashboard-cleanup-scope`                                                            | The same cleanup was scoped to the whole session rather than one graph, so one tab closing invalidated another's tables.                                                  |
| `22ddfb8d54` don't drag a card by the chart surface      | `chart-surface-drag`                                                                 | Both Dune charts are interactive — you pan the node graph and expand directories — and the dashboard card treated every pointer-down on the chart as the start of a drag. |
| `5363265631` right-aligned cells' action buttons         | `grid-cell-align-right-actions`                                                      | The node chip's ＋/－ toggle is a cell action, and in a right-aligned (numeric) column the buttons landed at the left edge.                                               |

### The chart-type registry

The plugin registers two chart types of its own. None of this existed.

| Commit                                                | Branch                        | Why the plugin needed it                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c811d9b0c5` plugin-registered chart types            | `chart-type-registry`         | The core requirement: chart types were a closed enum in the Data Explorer. This turns them into a registry a plugin can add to, and is by some way the largest of these changes (+1,178/−816).                                          |
| `9b2c22bd77` a chart type chooses its starting column | `chart-default-column`        | Both Dune charts read their primary column as a `dune_node.node_id`. The generic default picks the first non-numeric column — a label or a path — so a chart dropped on a Dune query joined a string against node ids and drew nothing. |
| `089bafee82` type switch honours `defaultColumn`      | `chart-switch-default-column` | The hook above was consulted on creation but not when switching an existing card's type, so switching _to_ a Dune chart reproduced the same empty picture.                                                                              |

### Brush filters

Clicking a directory in the Dune directory chart narrows the rest of the
dashboard. That path needed four fixes.

| Commit                                                   | Branch                     | Why the plugin needed it                                                                                                                                                                                                                  |
| -------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d52c549410` quote brush-filter values                   | `brush-filter-quoting`     | Directory paths contain characters that broke the generated `WHERE` clause unquoted.                                                                                                                                                      |
| `1bb55d2c34` quote brush-filter column names             | `brush-filter-identifiers` | The same hazard on the other side of the comparison.                                                                                                                                                                                      |
| `2002c98a71` no chart filters itself by its own brush    | `chart-no-self-brush`      | A Dune directory chart that brushed `dir_id` then re-filtered its own input by it, so clicking a directory made the card show only that directory — the brush ate the picture it was drawn on.                                            |
| `4b07f9e166` stamp a brush filter with its chart         | `chart-brush-owner`        | Needed to tell _whose_ brush a filter is, which is what makes the fix above possible with more than one chart on the dashboard.                                                                                                           |
| `0cce31ce2e` publish brush filters on the render context | `chart-brush-context`      | The directory card has to work out, after a reload, which directory it had brushed — the answer is in the persisted filters, and a renderer could not see them. Populated only on the dashboard path; see the plugin README's loose ends. |

### The DataGrid

| Commit                                                    | Branch                      | Why the plugin needed it                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8667c206aa` DataGrid cell renderers from column metadata | `datagrid-column-renderers` | The single most reused thing here. A column typed `JOINID(dune_node.node_id)` renders as a Dune node chip in _every_ grid in the UI, without any of those grids knowing about this plugin. Also moved 148 lines out of `results_panel.ts`, which had been hard-coding the equivalent. |

### The query page

The plugin's own query page is a sibling of the core one, so the parts worth
having twice were moved into `components/query_table` rather than copied.

| Commit                                              | Branch                      | Why the plugin needed it                                                                                                                                                                         |
| --------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `1f1dc9aa24` table list into components             | `table-list-component`      | The "Tables" sidebar. The Dune page lists the `dune_*` surface alongside the stdlib; the widget was private to `dev.perfetto.QueryPage`. (Nat's own change, predating the plugin's need for it.) |
| `9b40c8a506` key the table list's sections          | `table-list-keyed-sections` | The Dune page's sections arrive at different times — the stdlib catalogue loads asynchronously — and unkeyed sections re-rendered wrongly when one appeared.                                     |
| `4d6c81f371` share the query page's tab persistence | `tab-persistence-helper`    | The Dune query page remembers its tabs; the core page already did the same thing, privately.                                                                                                     |
| `8d52c1cddf` share the PerfettoSQL formatter        | none — **needs a branch**   | Format-on-demand in the Dune editor. Also touches `bigtrace/pages` and `dev.perfetto.QueryPage`.                                                                                                 |

### The node registry

The plugin registers nine source nodes and ten macro nodes of its own into the
Data Explorer's add-node menu. None of this was possible: the node set was a
closed registry with no disposal and no duplicate guard.

Unlike the others, this is **one branch carrying four commits** rather than one,
ordered so each is a no-op in behaviour and lands under the existing tests, with
the availability change last. The branch was rebuilt off `main` once the menu
shape changed, so it no longer carries the menu-nesting pair that the
integration line still has and then undoes — see "Not for upstream".

| Commit                                                 | Branch                        | Why the plugin needed it                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e3b54d5e8a` `NodeType` open to plugin-defined values  | `data-explorer-node-registry` | `NodeType` was a string enum, so a plugin's own node type was not assignable to it. The const-object form admits one without touching the ~50 signatures that name the type.                                                                    |
| `cd6c7f5bc0` a node's input arity from its descriptor  | `data-explorer-node-registry` | `singleNodeOperation()` was a hardcoded switch, and it decides both whether a node renders an input port and whether an edge into it is legal. A plugin node would have rendered portless and rejected every connection.                        |
| `e333cc491c` plugins can register node types           | `data-explorer-node-registry` | The core requirement. `register()` returned void with no duplicate guard, and the allowed-children list froze when `registerCoreNodes()` finished, so a later registration got no `+` menu and no incoming edges.                               |
| `bde9e34387` a node type can report itself unavailable | `data-explorer-node-registry` | Nine of the nineteen Dune nodes read the edge tier, which takes minutes to build and refuses outright past a hard cap. They are greyed out with a reason until it exists, rather than hidden or offering to start that build from a menu click. |

### Not for upstream

| Commit                                                                      | Why                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `2ea839aae1` **[TEMP] Enable plugin by default**                            | Edits `core/embedder/default_plugins.ts` so the plugin loads locally. **Must never be upstreamed.** Drop it when splitting branches.                                                                                                                                                             |
| **[TEMP] Trim the default plugin list**                                     | Deletes 62 entries from the same `default_plugins.ts`, leaving the 26 a Dune trace can use: the core UI, generic track rendering, the query surfaces and DuneGraph's own closure. Purely local ergonomics — a Dune trace has no ftrace, sched, Android, Chrome, GPU or power data for the rest to bind to, but they still run their `onTraceLoad()` on every open. **Must never be upstreamed.** Note that `core_plugins/` are gated by this same list — `isCore` only groups them in the settings page — so the core UI entries are load-bearing, not cosmetic. |
| `fb440d6a97` revert the dashboards hook and rename `dir_tree_graph.ts`      | Reverts an earlier commit on this branch. The net upstream diff of `DataExplorer/index.ts` is therefore **zero** — the file does not appear in the net diffstat at all. Nothing to upstream; nothing to do.                                                                                      |
| `b4111b6790` nested menu categories, `2b046f716b` a plugin's own menu group | Both are undone later on the line by `0ed9bf51fe` "put the Dune nodes in the existing menu sections", which puts the Dune entries in the existing type sections instead. Their net diff is zero, and `data-explorer-node-registry` was rebuilt without them. Nothing to upstream; nothing to do. |

## Branch status

18 topic branches exist, stacked on whichever branch introduced the code they
fix. All carry one commit except `data-explorer-node-registry`, which carries
four. The four commits with no branch are called out above: `5280bf7452` and
`b8abfef93f` want squashing/splitting into `data-explorer-dashboard-grid`,
`8d52c1cddf` wants a branch of its own, and `2ea839aae1` wants dropping.

```
dev/nat/brush-filter-identifiers      dev/nat/dashboard-cleanup-scope
dev/nat/brush-filter-quoting          dev/nat/dashboard-recover-after-cleanup
dev/nat/chart-brush-context           dev/nat/data-explorer-dashboard-grid
dev/nat/chart-brush-owner             dev/nat/datagrid-column-renderers
dev/nat/chart-default-column          dev/nat/grid-cell-align-right-actions
dev/nat/chart-no-self-brush           dev/nat/tab-persistence-helper
dev/nat/chart-surface-drag            dev/nat/table-list-component
dev/nat/chart-switch-default-column   dev/nat/table-list-keyed-sections
dev/nat/chart-type-registry            dev/nat/data-explorer-node-registry
```

Nothing is pushed. No PR has been raised for any of them.

## Things learned splitting these branches

Worth reading before the next split.

- **Every cherry-pick conflicts.** These commits were written on a tree holding
  _all_ the topic branches at once. Resolution means keeping the production
  change in full and dropping test expectations that belong to other branches.
- **A clean cherry-pick is not a signal.** On one branch git took the
  integration branch's test file wholesale (the merge base equalled the base),
  and it referenced `chart_type_registry`, which does not exist in that lineage.
  Only `tsc` caught it. **Always diff the test files against the base after a
  pick.**
- **The same trap, from the other side.** `data-explorer-node-registry` was
  written off `main`, where the chart-type registry does not exist either — on
  `main` that file is still a frozen const array under `query_builder/nodes/`.
  The node registry deliberately only _resembles_ it, so the branch stands
  alone; nothing in it imports the chart registry, and its commit messages do
  not claim a sibling file that a reviewer of that branch could not find.
- **A test harness's `vi.mock` path is lineage-specific.** `chart-brush-owner`'s
  harness mocks `chart_renderers`, not `chart_type_registry`; rebasing it onto a
  base that has the registry means flipping that path.
- **`chart-brush-owner` deletes four tests from its own base**, deliberately:
  the base commit added them to assert on `adapter.brushedColumns`, which is the
  mechanism that commit removes. Each has a replacement asserting the same
  intent through a rendering harness, plus four cases the old set could not
  express.
- **No branch in this repo sets `branch.<name>.parent`**, so `CLAUDE.md`'s "get
  a diff" command needs one set first.

## Follow-ups this plugin created but did not take

- **`AccordionAttrs.key`** (`ui/src/widgets/accordion.ts`) is declared and
  passed by nobody. The keyed-sections fix (`9b40c8a506`) made that unambiguous.
  Upstream code, so it is recorded here rather than deleted from the plugin's
  side.
- **`ChartRenderContext.brushFilters`** (`0cce31ce2e`) is populated only on the
  dashboard path. A chart on a visualisation node still cannot recover a brush.
- **`sql_formatter.ts` caches a rejected promise for the session**, so one
  failure disables formatting until reload. Noticed while sharing it
  (`8d52c1cddf`), not fixed.
