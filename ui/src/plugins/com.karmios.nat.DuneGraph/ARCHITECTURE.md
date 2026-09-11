# DuneGraph — architecture

How the plugin is built and why. **[README.md](README.md) is the user-facing
half** — what the surfaces are, how to record a trace, what the `dune_*` SQL
surface holds, and the limits you can hit. This file is for working on the code.

The plugin's own comments point at sections of this file by name, so **renaming
a heading here breaks those pointers** — `docs_unittest.ts` checks every one of
them resolves, and fails if it does not.

## Contents

1. [Layout](#layout)
2. [What a Dune trace contains](#what-a-dune-trace-contains)
3. [The surfaces, in code](#the-surfaces-in-code)
4. [The Explorer pane](#the-explorer-pane)
5. [The load path](#the-load-path)
6. [The graph model](#the-graph-model)
7. [The blob format](#the-blob-format)
8. [The SQL mirror](#the-sql-mirror)
9. [Performance](#performance)
10. [Gotchas](#gotchas)
11. [Testing](#testing)
12. [Loose ends](#loose-ends)

---

## Layout

Files are laid out in dependency order; imports only ever point _downwards_, and
`layering_unittest.ts` enforces it.

| Layer | Directory             | Holds                                                                                                                                                                                |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | `perf.ts`             | Load-time instrumentation. Depended on by everything, depends on nothing of the plugin's own.                                                                                        |
| 1     | `model/`              | The graph: the columnar store and its walks, the blob parser and builder, the integer containers, the path/directory algorithms, the track vocabulary. Pure — no engine, no mithril. |
| 2     | `sql/`                | The SQL mirror: the two tiers, the timing pipeline, the process table, the catalogue.                                                                                                |
| 3     | `controller.ts`       | Owns the graph, the mirror handles, the load queue, the selection and the timeline workspace. Everything above reads state off it.                                                   |
| 4     | `views/`, `explorer/` | Mithril. `views/` is the side panel, the timeline projection and the query surfaces; `explorer/` is everything that reaches into `dev.perfetto.DataExplorer`.                        |
| 5     | `index.ts`            | Registration, and nothing else.                                                                                                                                                      |

Two seams exist purely to keep that acyclic:

- **`model/graph_tracks.ts`** holds the track kinds, specs and uri helpers.
  Three layers need to _name_ a track while only the renderer draws one — the
  controller registers and seats them, the details panel says which track a row
  came from — so the names live below all three.
- **`views/graph_host.ts`** is the interface the views read their host through.
  `DuneGraphController` satisfies it structurally, without importing it.

`styles.scss` stays at the root: one stylesheet for the whole plugin, imported
by `index.ts`.

## What a Dune trace contains

Three things this plugin cares about, all of them ordinary trace data:

- **Lifecycle instants** on the `exec-rule`, `build-dep` and `exec-rule-action`
  tracks. Each carries a `-start` / `-finish` pair, or a single collapsed
  `-resolved`, tagged with a `rule_id` or `dep_id` arg. These are the _timing_.
- **The graph blob**: instants on a `dune-graph` track whose `data` arg holds
  chunks of a five-section text format describing the build graph's _structure_.
  See [The blob format](#the-blob-format).
- **Process slices**: a duration event named `process` on a `job-<n>` track per
  build job slot, tagged with a `debug.dune.forced_by` arg naming what pulled it
  into the build.

The `gen-rules` and `dynamic-includes` lifecycle tracks are deliberately
ignored: their start and finish instants share no join key, so they cannot
become nodes.

What the plugin adds is the join between those three — the structure says _what
depends on what_, the instants say _when each thing happened_, and the process
slices say _what was actually run_.

## The surfaces, in code

The four surfaces themselves are described in
[README.md](README.md#what-it-shows); this is how each is put together.
Everything is registered from `index.ts`.

### Side panel — `views/panel.ts`, `views/dir_explorer_panel.ts`

Two tabs. **Dune** (`views/panel.ts`) is the node-centric view, and before a
graph is loaded it is also the load screen. Once loaded it is two stacked areas:
`views/selection_info_panel.ts` for the node behind the current timeline
selection, and `views/graph_panel.ts` for the set of nodes chosen for the graph.
The selection panel's body is three accordion sections — `processes`, then
`dependants` and `dependencies` as path-grouped trees.

**Explorer** (`views/dir_explorer_panel.ts`) is a second tab rather than a third
area of the first: a directory tree wants the whole panel height, and it has
nothing to do with what is selected. The same pane also renders as a Data
Explorer chart — see [The Explorer pane](#the-explorer-pane).

### Timeline — `views/graph_track.ts`, `views/arrows.ts`

Four tracks in a `Dune graph` workspace, one per kind of row: `dep`, `rule`,
`rule-action` and `process`. They are registered once and live for the trace;
only their _contents_ follow the graph selection, via a dataset closure.

Four fixed tracks rather than one per selected thing, because a Perfetto track
is a stable container — deriving tracks from the selection made them churn on
every add and remove, and needed a registration lifecycle, a cap, and somewhere
to put the overflow. What that gives up is the nesting (a dep over its rule over
its action over its processes), which is real but not expressible by four
independent tracks. That relationship is _drawn_ instead, as arrows, using the
same `RelatedEventsOverlay` machinery the Android plugins use for causally
related events. Only the selected row's chain is drawn: every chain at once was
a thicket and needed an arbitrary cap to stay affordable.

### Query — `views/query_page.ts`, `views/query_tab.ts`, `views/query_results.ts`

SQL over the mirror, in two places that share one results view:

- A **details-drawer tab**, driven by the `@` omnibox mode and the
  `Dune: query graph` command. The fast one-off lookup next to the timeline you
  are already reading.
- A **full page** at `#!/dune_query`, reachable from the sidebar and
  `Dune: open query page`. A strip of editor tabs each with its own buffer and
  results, a query-history sidebar, a `dune_*` table catalogue
  (`sql/dune_tables.ts`), and the graph-load state called out _before_ a query
  runs rather than reported as an error afterwards. Optionally remembers its
  tabs across reloads (off by default; SQL only, never results).

Both render `DuneQueryResults`, which is what knows about nodes: a `node_id`,
`src` or `dst` column draws a kind chip, a label linking to the node's slice,
and a ＋/－ graph-membership toggle. There is a tree mode that groups results by
path.

### Data Explorer — `explorer/`

Four separate offers into `dev.perfetto.DataExplorer`:

- Two **sources** the side panel can append to the graph you are working in:
  `dune_dir` (`explorer/dir_tree_source.ts`) and `dune_node`
  (`explorer/node_source.ts`). This is the only place DuneGraph reaches into
  another plugin, and it goes through that plugin's public `getActiveGraphJson`
  / `setActiveGraphJson`.
- Two **chart types**, registered per trace: `dune-dir-tree`
  (`explorer/dir_explorer_chart.ts`) draws a query's rows as the part of the
  directory tree they landed in, and `dune-node-graph`
  (`explorer/node_graph_chart.ts`) draws them as the build graph between them.
  Both read `config.column` as _the column holding a `dune_node.node_id`_. That
  handling, and the stand-in views both cards draw before they have a picture
  (waiting, loading, error, no matching nodes), are shared in
  `explorer/chart_node_column.ts` — the two cards say the same thing in those
  states, so they say it in one place.

Both **sources** become a two-node chain wrapped in a group named after them:
`sql_source (SELECT … FROM <table>) -> modify_columns`. The `modify_columns`
node looks redundant — the source alone is the obvious graph — but it is what
makes the chain usable on a dashboard, for a reason invisible from the dashboard
end. A dashboard item renders nothing until its data source reports columns
(`DashboardGridView` bails out with "No columns" before it would ever ask for
execution), and a `sql_source`'s `finalCols` are _discovered by running it_:
empty on a freshly loaded graph, and the node is `autoExecute: false`, so
nothing runs it until someone presses "Run Query". A `modify_columns`'s
`finalCols` come from its _serialized_ `selectedColumns` instead, so the columns
are known the instant the graph loads, the grid renders, and its own
wait-then-`requestExecution()` materialises the whole chain. It is also the only
place a column's _type_ can be declared, which is what decides how the grid
renders it.

The chain is appended into the graph the user already has, in a group, and
**nothing is exported to a dashboard**: the button's job is to make the data
available, not to decide what is done with it, and connecting a `dashboard` node
to the group's output is one drag away. Everything already in the graph survives
untouched, ids and all — the ids are what the user's dashboard items name their
data sources by.

`views/node_cell.ts` additionally teaches **every** DataGrid in the UI to render
a `JOINID(dune_node.node_id)` column as a node chip, so a grid built anywhere —
the query page, a Data Explorer results panel, a dashboard — draws nodes the
same way.

## The Explorer pane

One pane — `views/dir_explorer_panel.ts` — renders in two places, the side
panel's Explorer tab and the `dune-dir-tree` chart. Almost none of it is about
data: the expansion set, the inline/bucket decision, the paging, the label
arithmetic and the filter menu are the same whatever is being explored. The
handful of calls that _are_ about this tree in this mirror is the
`DirExplorerSource` interface (`views/dir_explorer_source.ts`), which is what
makes the pane mountable over something that is not `dune_dir`.

### What an implementation has to promise

The pane leans on more than the signatures:

- **Directory ids are the identity of everything.** They key the pane's caches
  and its expansion set, and `views/dir_filter.ts` additionally needs them dense
  from zero with a parent's id always below its children's (which is where
  `model/dir_tree.ts` gets that property). Numbering them another way breaks the
  filtered tree silently.
- **Compression is the source's job.** `rootDirs` / `childDirs` return rows that
  may sit several directories below where they were asked for, and the pane
  labels a row by subtracting the path of the row above it. What it must not get
  is a pass-through row, or two rows for one seed.
- **Members are paged, rules before deps, and a short page ends the list.** The
  pane reads the end of a list off the row count rather than asking for a total,
  so a source returning fewer rows than asked for while more remain hides them
  behind a "show more" that is never offered. The order must be stable across
  calls, so consecutive offsets are pages of one list.
- **`matchingCounts` returning undefined means "all of them".** That is what
  lets `FilteredTree` fall back to the stored `n_rules` / `n_deps`, and what
  keeps a deps-only filter from counting rules at all.
- **`version` is bumped when the ids stop meaning what they meant.** Everything
  the pane holds is derived from the source, so this is how a source says so and
  the pane drops the lot. Read every render, so it must be a field or a getter
  over one.

### Two shapes of source, and the mode each drives

Which mode the pane is in is the source's to declare, via `rowDriven`:

|                          | `SqlDirExplorerSource` (`views/dir_explorer_source.ts`) | `ChartDirExplorerSource` (`explorer/dir_chart_source.ts`)      |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------------------------- |
| Is a source of           | a **hierarchy**, descended lazily a level at a time     | a **selection** — the rows a chart's query named               |
| `rowDriven`              | `false`                                                 | `true`                                                         |
| Builds a `FilteredTree`  | only when the user filters                              | always, from `allDirs` + `matchingCounts` with an empty filter |
| `rootDirs` / `childDirs` | the lazy descent                                        | never called; they throw                                       |
| Per-row counts read      | "3 rules"                                               | "3 of 1,204 rules"                                             |

The SQL source is thin — every member is the matching `model/dir_explorer.ts`
function with the engine bound, because that is the half worth unit-testing.

A row-driven source is _always_ narrowed (its counts **are** the filter), which
is a state the pane would otherwise never enter — hence the flag, since getting
it wrong is silent either way. What `rowDriven` does not change: the pane's own
path box and Filters menu are offered either way, and their predicates go into
the same queries the source answers `matchingCounts` and `dirMembers` from, so
the two narrowings AND.

### Counts and members are bounded differently, because they are different sizes

This is the whole design of `explorer/dir_chart_source.ts`. Pulling the input
rows in once and deriving both from them ties both to the size of the _input_,
which is unbounded: a bare `SELECT … FROM dune_node` chart is one button away
and names all 818k nodes of the monorepo trace. So each is bounded by what
actually bounds it:

- **Counts** are an aggregate. One `GROUP BY dir_id, kind` returns at most two
  rows per _directory_ however many input rows went into it, so it needs no cap
  and the tree is complete at any scale.
- **Members** are needed only for the directories the user expands, one
  `MEMBER_PAGE` at a time. Each page is its own bounded query, so the input
  query is re-run per page — which is what the trace processor is for, and the
  same trade the SQL source makes on expansion.

An input naming the same node more than once is normal rather than exotic — an
edge query has a `src` per edge, not per node — so both queries count _nodes_,
each the way its join direction suits. The counts query is driven **from** the
input (there is no directory to start at, and the input is normally the small
side), so it de-duplicates first with `SELECT DISTINCT` and then counts; member
queries are driven **into** it, starting from one `dir_id` and testing against
the input with `node_id IN (…)`, where a semi-join returns each node once by
construction.

Two things deliberately do not follow the pane's filter, both read off the
unfiltered load: `state.nodeCount`, which answers "did this column name any Dune
nodes at all" and so is about the chart's config rather than the filter, and
`subtreeDirIds`, which is what a dashboard brush should name.

### Why the pane owns its tree state

`widgets/tree.ts`'s `LazyTreeNode` is very nearly this component: collapsed to
start, `fetchData()` on first expand, children cached thereafter. What it cannot
be is **invalidated**. The kind toggles change how much a directory has to show,
and so whether its members are listed inline or bucketed by kind — a directory
with 5 rules and 4,000 deps is bucketed with both kinds visible and inline with
deps hidden — so a toggle has to reach into an already-expanded directory and
re-decide that. `LazyTreeNode` keeps its children in a private field with no way
in, and forcing the issue with a mithril `key` would destroy the component,
collapsing every directory in the tree on every toggle.

So the state lives in the pane: which rows are expanded, which fetches have
completed, which pages of a bucket have been read. The payoff is that the caches
are keyed by directory rather than by component, so expansion state and loaded
rows both survive a toggle, and toggling a kind _off_ never needs a query.
Toggling one _on_ can, for directories already expanded that now cross the
inline threshold, and those fetches are issued by the render that needs them
rather than all at once by the toggle.

### The path filter's syntax

`model/dir_explorer.ts`'s `compileFilter`. Wildcards are **detected** rather
than assumed either way, because the two things people type want opposite
treatment: `lib` means "anything with lib in it" and becomes a case-insensitive
`*[lL][iI][bB]*`, while `lib/*.cmi` is a pattern the user wrote deliberately and
is used as a glob — wrapping it in further stars would be harmless, silently
case-folding it would not.

A `\` escape sits underneath that choice rather than replacing it: it makes a
metacharacter literal _and_ stops it counting as a wildcard when picking the
arm. So `foo\*bar` searches case-insensitively for a literal star, while
`lib/\*.cmi*` is a glob whose first star is literal and whose last is real.
Plain text with no backslashes takes the plain arm untouched — the effortless
case must not pay for the escape hatch. A `\` before anything not escapable is
_itself_ literal and the next character is read normally (`a\b` searches for
`a\b`, not `ab`), as is a trailing `\`: never discarding input beats a tidier
rule, and a stray backslash in a build path is likelier than a deliberate escape
of `b`.

Two independent quoting layers meet here: this is **GLOB** quoting, and
`sqlValue` separately does SQL string-literal quoting when the pattern is
interpolated. Conflating them is a bug in both directions. GLOB is always
case-sensitive with no pragma to change it, which is why a case-insensitive
match is spelled as `[aA]` classes.

Attribute filters are all per-kind, and the two kinds are narrowed
independently: **a kind whose attributes nothing selects matches all of its
members.** "Show me the failed rules" is an outcome filter plus hiding
dependencies, not an outcome filter that silently also means "and no deps" — the
pane already has a better answer to "which kinds am I looking at" in its
Rules/Dependencies toggles. The path applies to both kinds on different columns:
a dep's own full path, a rule's containing directory.

### Clicking a directory narrows the dashboard

A directory row's filter button emits `setBrushSelection('dir_id', [...])` over
the directories its subtree actually holds rows in — not the whole subtree,
which runs to thousands of directories holding none of the query's rows and
would be that many more values in the `dir_id IN (…)` the filter becomes. That
lands as repeated `=` filters and renders as `dir_id IN (…)`, so it needs
nothing new from the host; it does need the query to _have_ a `dir_id` column,
which is why the button is only offered when one is there. Any query over
`dune_node` carries it for free. `dir_id` deliberately rather than the chart's
primary column: what is being narrowed is _where_ the rows are, a different
question from which column named them.

The button is a toggle — clicking the already-brushed directory clears it —
which needs someone to remember which directory that is. The pane cannot: it
hands out a directory and hears nothing back. So the answer lives in
`explorer/dir_explorer_chart.ts`'s `brushes` map, keyed by chart config id
rather than held on the source, because a consumer card's own query carries the
brush filters — brushing rebuilds the loader and the source with it, so state on
the source would be dropped by the very click that set it.

`brushes` dies with the trace and the brush is saved with the tab, so after a
reload the card has filters and no `dirId` and works it out again from the
persisted filters, which carry the id of the chart that set them
(`recoverBrushedDir` → `rootOfDirIds`). Every step of that is optional and it is
silent about failing: where it stops, the card is brush-blind but working.

The pane's own path box and Filters menu narrow _this_ card's tree and nothing
else. Deliberately: a brush persists with the tab and the pane's filter does
not, so a dashboard reopened after a filter brush came back narrowed by a filter
nothing on screen was showing.

### The hard filter is client-side, and the unfiltered tree is not

Everything downstream of the counts — the subtree rollup, the hard filter, the
compression, the expansion remapping — is `views/dir_filter.ts`: client-side and
arithmetic, over a whole-hierarchy `allDirs` read once per filter application
rather than per expansion. Only member _rows_ are still fetched per directory.

The unfiltered pane never needs to know what is deeper than the level it draws:
`dune_dir`'s stored `t_*` rollups answer "is there anything down there" for
free. A **hard** filter cannot work that way — hiding a directory needs to know
whether its whole subtree holds a match, and the filter is user-typed, so no
stored rollup answers it. That rollup needs the whole hierarchy at once, hence
the one 19k-row read and the arithmetic.

It rests on `model/dir_tree.ts`'s invariant: ids dense from zero, a parent's
always below its children's. So id order _is_ topological order, the subtree
rollup is one descending pass over an array, and no recursion or child index is
needed for it.

Hard-filtering creates new single-child chains — filter to one deep path and the
tree above it is a ladder of one-child rows — so the pane's pass-through
compression is re-run over the _filtered_ tree, reading "no matching members of
its own, exactly one visible child". That subsumes the SQL compression rather
than composing with it, which is why the filtered path ignores `compressedDirs`
entirely. It is also why expanded ids have to be re-keyed (`remapExpanded`):
compression re-decides which directory a row is keyed on, so an id that named a
row before the filter can name a swallowed directory after it.

## The load path

Nothing loads when the trace opens. On a monorepo-scale trace the load is
minutes long and would hold up the whole UI (and exhaust the trace processor
heap under every other plugin), so `onTraceLoad` registers surfaces and returns.
`controller.ts` owns the rest.

The work splits into three steps, cheapest first, each separately reported in
the panel and separately re-runnable:

| Step                | Does            | Produces                                                                                            |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `loadGraph()`       | parses the blob | the in-memory `BuildGraph`                                                                          |
| `buildNodeMirror()` | node tier       | `dune_node`, `dune_rule`, `dune_dep`, `dune_rule_target`, `dune_string`, `dune_dir`, `dune_process` |
| `buildEdgeMirror()` | edge tier       | `dune_edge`, `dune_edge_blocked`, the factored storage, the relation functions                      |

Each is idempotent (already-`ready` is a no-op) and pulls in the steps it
depends on, so any can be called from cold. They all run through one queue —
they mutate the same SQL table names, so two must never overlap — and a
`reload()` bumps a generation counter that drops whatever was queued behind it.

A fourth `LoadStep`, _Trace stats_, is the cheap headline probe: two SQL
aggregates measuring the blob's section sizes inside the engine, so nothing
crosses into JS. It is what `init()` runs, and what the panel shows before a
load.

### The one question, and the one refusal

There is exactly **one** number the user is asked about, and one the plugin
refuses on:

- **`AUTO_LOAD_ROW_LIMIT_SETTING`** (default 2,000,000 estimated stored edge
  rows) is the soft gate. Below it the graph loads itself as soon as the trace
  opens; above it, opening the trace costs nothing and the panel shows what a
  load would involve. The estimate comes from the blob's _byte size_, not a
  parse, so it is available before any expensive work — which is what makes it
  the only number worth asking about. A yes there buys all three steps.
- **`EDGE_HARD_LIMIT`** (100,000,000 edges, `sql/sql_graph.ts`) is a refusal,
  not a prompt: past it the edge tier would take the engine down, so `load()`
  skips it and the panel says so. It counts _edges_ rather than rows because by
  the time it is consulted the graph is parsed and the exact edge count is
  known; the soft gate has the opposite problem and so counts rows.

A missing or half-built mirror is a **usable** state everywhere: the timeline
tracks select from `where 0`, the query surfaces refuse up front naming the load
command, and the panel shows a strip rather than hiding the graph.

### Inside `loadGraph()`

`model/trace_graph_source.ts` reads the blob in two passes: a cheap metadata
query that validates each section's chunk set without reading a byte of payload,
then **one query per chunk**, each fed straight into the streaming parser. Not
one query for everything: a query result holds every string column it returned
for as long as it is alive, so a single blob query would keep the whole payload
live for the entire parse, on top of what the parse itself builds.

Records stream from `model/graph_blob.ts` into `model/graph_build.ts`, which
copies each record's scalars into per-node columns and each dep reference into
an edge vector, then drops the record. Nothing the parser hands over is
retained. References cannot be resolved as they arrive (a rule names dep ids,
and the deps section is parsed after the rules section), so ingest stores the
blob's trace-side ids and `GraphBuilder.finish` rewrites them in place — one
pass over the edge vector, no second copy — marking the ones no record turned up
for as _dangling_.

Timing is not read here at all. Since the lifecycle pairing moved into SQL
(`sql/lifecycle_sql.ts`) nothing timing-shaped crosses into JS during a load; a
node's timing is looked up when it is shown.

## The graph model

`model/graph.ts`. Two kinds of node, both sourced from the blob (structure) and
the lifecycle instants (timing):

- **`dep`** nodes, from `graph-deps` records / `build-dep` instants. A dep
  resolves either to a rule, or to a set of further deps (an _expansion_), or is
  a source file, or is unfinished.
- **`rule`** nodes, from `graph-rules` records / `exec-rule` instants, which
  carry the rule's static deps and its dynamic-dep stages.

**Every node is a dense integer `NodeId`**, rules in `[0, ruleCount)` and deps
in `[ruleCount, nodeCount)`. So a node's kind is a comparison (`graph.ts`'s
`kindOf` / `isRule`), and the SQL mirror's `node_id` is the _same number_ — no
maps in either direction. Trace-side ids (a dep's dict id, a rule's `rule_id`)
are kept as columns and indexed back by `IntIndex`.

**Everything about a node lives in a typed-array column, and its edges live in
one CSR** (`edgeOffset` + `edgeTarget`). A `GraphNode` is a _view_, materialised
on demand for the handful of nodes a panel is actually showing; the walks
(`descendants`, `ancestors`, `inducedEdges`, …) take and return node ids, and
only call sites that render something materialise a view. The two integer
containers this is built out of are in `model/columns.ts`: `Int32Vector`
(chunked, 1M entries per chunk, so growth costs 4 MB and no copy) and
`IntIndex`.

The reason is scale. The monorepo trace's ~818k nodes and ~28.8M edges, as
objects-with-arrays, were multiple GB and never finished loading; as columns
they are ~155 MB of typed arrays plus a ~62 MB intern table.

Small enums — a rule's outcome, a dep's resolution and status, a `forced_by`
kind — are stored as their index in the corresponding list in `graph.ts`
(`RULE_OUTCOMES`, `DEP_RESOLUTIONS`, …). **That order is part of the encoding,
so only ever append**, which is why the codes added with dune's failure states
sit after the fallbacks rather than beside their siblings.

## The blob format

`model/graph_blob.ts` parses it; the schema itself is dune's, documented in
`doc/dev/trace-graph-perfetto.md` in the dune repo. The parser is pure — no
engine access — so every corner of the grammar is unit-testable, and
`model/trace_graph_source.ts` is its only caller.

Five sections, each reassembled from its chunks by `seq` before parsing:

| Section         | Record                                                                                                          | Notes                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `graph-dict`    | `<id>\t<string>`                                                                                                | The intern table. The only section whose values are escaped (`\\`, `\t`, `\n`) — everything else is an id or a short tag.           |
| `graph-cores`   | `<core_id>\t<dep_ids>`                                                                                          | A shared _core_: the common member prefix of popular dep sets. Flat — a core's members are always dict ids, never another core.     |
| `graph-depsets` | `<set_id>\t<core_id>\t<add_ids>`                                                                                | A distinct dep set = its core's members plus its own adds. Rule dep sets and dynamic-dep stages share this table and this id space. |
| `graph-rules`   | `<rule_id>\t<dir_id>\t<target_file_ids>\t<target_dir_ids>\t<outcome>\t<forced_by>\t<dep_set>\t<dyn_dep_stages>` | One line per `exec-rule` span occurrence.                                                                                           |
| `graph-deps`    | `<dep_id>\t<resolution>\t<forced_by>\t<status>`                                                                 | One line per `build-dep` span.                                                                                                      |

**A rule names its deps by set id rather than listing them.** The same dep set
repeats across thousands of rules, so the blob factors the sets out and a rule
carries one integer; each dynamic-dep stage is likewise one set id. Nothing in
the parser expands them — that is `graph_build.ts`.

Points that bite:

- `<set_id>` and `<core_id>` are allocated **from 0** in first-sight order, so
  an empty field is emphatically _not_ id 0. Like `rule_id` they are per-process
  join keys within one blob, never stable identities.
- A set is stored sorted **as text** (so `10` precedes `9`) and duplicate-free,
  split across a core and an add list — so **a rule's declaration order for its
  deps is not recoverable**. Anything displaying them sorts by resolved path.
- **`?` and "empty" are not the same thing, and `?` is not the failure signal.**
  Dune reports a failed or torn-down build through the ordinary fields (a
  `D`/`A`/`C` outcome, a `u` resolution, a non-empty status) and reserves `?`
  for a span that genuinely never ended, i.e. a truncated trace. Likewise `?` in
  `<dep_ids>` means "dune could not determine this rule's deps", which is not
  the empty field's "this rule has none" — `RuleRecord.depsUnknown` keeps them
  apart, since both parse to no set at all.
- `<status>` is a later addition to `graph-deps`; a three-field line is read as
  `ok`, which is what the schema meant before the field existed.
- **Sections are parsed as a stream, one chunk at a time.** `parseGraphBlob`
  takes an async iterable of chunk payloads per section, not a reassembled
  string: `graph-rules` alone was ~190 MB of text on a v1 monorepo trace. **A
  record never spans a chunk** — the exporter splits only on line boundaries, so
  each chunk is closed off (`LineReader.end`) before the next is pushed, and the
  dict's chunks are joined on a newline rather than bare. That guard is what
  makes an exporter emitting `\n`-_separated_ rows safe as well as one emitting
  `\n`-_terminated_ rows; dune has since moved to terminated, but it separated
  at first, and a carried partial glued the last record of one chunk to the
  first of the next. Keep it: it costs nothing against a terminated blob and it
  is what lets an already-exported trace still load.
- Records are handed to a `GraphBlobSink` as they are parsed rather than
  collected into arrays.

## The SQL mirror

`sql/sql_graph.ts` materialises the in-memory graph into Perfetto SQL, so the
graph can be queried by _relationship_ in the same engine as the rest of the
trace. `sql/dune_tables.ts` is the hand-written catalogue of the _public_
surface for the query page's sidebar — hand-written because the tables are
created at runtime and so are not in the `SqlModules` stdlib catalogue, and
because the wire format carries no column comments. The `_dune_*` storage is
deliberately not catalogued: its shape changes without notice, and the sidebar
is an invitation to query. A unit test parses `sql_graph.ts`'s `CREATE` strings
and fails if the catalogue and the public views disagree.

### Two tiers

Built as two independently-owned halves, because their costs differ by orders of
magnitude. The **node tier** is one row per node plus its per-kind detail; the
**edge tier** is the edges, stored factored. The edge tier reads the node tier's
tables and owns an index on one of them, so it must be built _after_ the node
tier and disposed _before_ it.

### Three mechanisms that make it fit

**Every stored column is an integer.** The raw `_dune_*` tables hold ids, small
codes and counts; the text a query wants is reconstituted by the
`CREATE PERFETTO VIEW` over each of them, which is also where the public column
names and types live.

1. **`dune_string(id, str)`** is the blob's intern table, copied in whole. Every
   path the mirror mentions is a dict id joined against it — a ~2x saving over
   storing the text, and a feature in its own right
   (`SELECT * FROM dune_string WHERE str GLOB '*.cmi'`).
2. **A node's kind is its id.** `ruleCount` is inlined into every generated
   statement, so no table and no edge row carries a kind column.
3. **Codes, not words.** An outcome / resolution / forcer kind is stored as its
   index in `graph.ts`'s list and mapped back by a `CASE` in the view — so those
   lists are part of the encoding.

The two header tables (`_dune_core`, `_dune_depset`) are the one departure from
"keyed by `node_id`". Their key is the _dense index_ `model/graph_build.ts`
assigned each core and set on arrival, not the blob's own `core_id` / `set_id`:
dense from zero means the key is the rowid, so a header lookup needs no index,
and the blob's own ids are per-process join keys with no meaning outside one
blob. `BuildGraph.depSetOf` hands out the dense index anyway, so nothing has to
translate, and `_dune_rule.dep_set` holds the same index.

### Why it is shaped this way

The user-facing inventory of the public tables is in
[README.md](README.md#the-sql-surface) and, in the product itself, in the query
page's "Tables" sidebar. What matters here is the shape.

**Split by kind rather than one wide table.** `dune_node` carries only what is
meaningful for every node; the detail tables carry what differs. This avoids
NULL-heavy rule-only columns and columns whose meaning changes by kind (a rule's
cache-hit outcome vs. a dep's resolution). The detail tables are keyed _on_
`node_id` rather than reached by a foreign key: `kind` already says which detail
table applies, so every join is a plain `USING (node_id)`.

**`node_id` is the in-memory graph's own node id.** The graph numbers densely
from zero for exactly the reason the stdlib graph macros want, so the mirror
inherits the numbering rather than assigning a second one — translating a node
to a `node_id` and back is arithmetic, not a pair of 800k-entry maps. Every raw
table is keyed by it as an `INTEGER PRIMARY KEY`, i.e. as the rowid, so none of
them needs a `node_id` index either.

**`dune_node.orig_id` is the trace-side id** (a dep's dict id, a rule's
`rule_id`), which is what joins to the lifecycle instants' args. It is _not_ the
display string — `label` is.

**A rule's edges are not stored.** They are the members of the dep set the blob
named, and the same set recurs across thousands of rules, so `dune_edge`
_reconstructs_ them from the factored `_dune_core` / `_dune_depset` tables. That
is what takes the tier from 28.8M rows to ~6.3M. Only a _dep_ node's edges are
still flat, in `_dune_edge`, addressed by rowid range through
`_dune_node_out(node_id, first_rowid, n)` — their rows are inserted in node-id
order, i.e. in the order of the in-memory CSR, so a node's out-edges are
contiguous and need no index on `src`.

**The relation functions read the arms directly, never `dune_edge`.** A
_constant_ constraint pushes into a compound view fine, but a constraint
arriving by joining the recursive table does **not**:
`JOIN <union view> e ON e.src = s.node_id` inside a recursive term cost ~2.7 s
per direction against ~0 ms with the arms as separate recursive terms. So
`dune_edge` stays a compatibility view for ad-hoc SQL and the walks get one
recursive term per arm. Related trap: **a view arm must expose its own join
key** — writing the dep arm as
`SELECT e.src … FROM _dune_node_out o JOIN _dune_edge e ON e.rowid >= o.first_rowid`
cost 21 ms/probe because `e.src` hides the key; `SELECT o.node_id AS src` cost
~0.

**Two tables still store text**, and for the same reason: a _constructed_ or
_prefix_ path has no dict id to intern against. `dune_rule_target.path` is a
rule's `dir` plus a relative name, and is the documented join key onto
`dune_dep.path` — keeping it stored and indexed is what makes that join an index
probe instead of a cross product. Write it deps-first
(`FROM dune_dep d JOIN dune_rule_target t ON t.path = d.path`): `USING (path)`
lets SQLite drive from `dune_rule_target`, and a dep's path comes out of a join
to `dune_string` with no index to probe back with — that phrasing does not
finish. `dune_dir.name` / `.path` are prefixes of interned directories, which
are not themselves interned.

**`dune_dir`'s directories are the union of every rule's `dir` and the
containing directory of every dep's path**, because ~23% of the deps on a real
trace (the opam switch, the compiler, `/usr/bin`) live under no rule's `dir` at
all. `self_dur_ns` / `total_dur_ns` sum _rule_ spans only — a dep's span is
waiting for build work rather than build work, so adding it would double-count.
`n_failed` counts `failed-deps` and `failed-action`; a cancelled or unfinished
rule is not a failure.

### Timing — `sql/lifecycle_sql.ts`

Node timing is entirely in SQL. The pairing of `-start` with `-finish` used to
happen in JS, which meant shipping every instant into the UI — 2.4M of them on
the monorepo trace, each with three `extract_arg` calls, plus a Map of the same
size from slice id back to node. It is now one SQL pipeline producing one row
per `(kind, key)` in `_dune_timing` — 1,204,322 rows — and nothing timing-shaped
crosses into JS during a load.

The pairing is deliberately **join-free**: instants are numbered per key with
`row_number()` and the two rows of an occurrence are collapsed with a
`GROUP BY`. The self-join this replaces is the same shape and ran for **223 s**
on the monorepo trace, so the rewrite is not stylistic.

Instants carry no occurrence index, so a key seen more than once (watch mode, or
a dep built repeatedly) is paired **in timestamp order** — the same heuristic
the JS did. `n_occurrences` on `dune_node` says when that happened.

`_dune_timing` is a plain `WITHOUT ROWID` table keyed on `(kind, key)` rather
than a `PERFETTO TABLE`, because every read of it is an equality lookup on that
key and `dune_node` joins it that way for every row it projects. A
`PERFETTO TABLE` serves such a probe by scanning the _whole table per driving
row_ — 94 µs a probe natively, ~256 µs in wasm, i.e. **208 s** to project 818k
nodes once. A `PERFETTO INDEX` does not change that, and nor does making `kind`
an integer. A real primary key does: same rows out, byte-identical, and the
projection drops to **2.2 s**. Both halves of the key are integers so the probe
is one b-tree descent, which is why `kind` is stored as a code. A plain rowid
table with a plain index fixes the asymptotics too, but at ~4x the lookup cost
and an extra index object.

**That shape costs 33.7 MB of resident SQLite pages, and that is the thing to
watch.** They land inside the arena freed after the trace parse. While the edge
tier stored one row per edge it needed that arena back, and _any_ ~34 MB of
resident pages was enough to make `CREATE INDEX` over 28.7M rows fail with
`database or disk is full` — a dummy rowid table of the same 1.2M rows failed it
identically, so it was never this table's shape that did it. Factoring the edge
tier removed the constraint (the widest index is now 4.03M rows) and the
end-of-load heap is 1,530.3 MB either way, against a 4 GB memory32 ceiling; the
db file grows 366.8 → 389.7 MB. If a future change makes the edge tier tight
again, this is the first thing to give back — and measure it the way that
failure was found: a full load through the wasm engine, reading the heap at the
**end**, not after the step you changed.

### Processes — `sql/process_sql.ts`

Process slices are not graph nodes and never become any: they carry no
`rule_id`/`dep_id` join key and have no blob record. They get a table of their
own (`_dune_process`) because finding them costs an `extract_arg` over _every_
slice in the trace, and the timeline track's SQL is regenerated on every graph
selection change — a multi-second full scan per click, several times over, since
`SliceTrack` builds two mipmaps and a row count from the same source.

**Both halves of the filter matter**: `process` is the name that carries the
semantics, and `forced_by` is not exclusively a rule — on one sample trace 182
of 1,151 process slices read `dep <path>` instead of `rule <rule_id>`, and a dep
forcer names no rule to hang the slice off. The table is keyed by `rule_id`, not
`node_id`, deliberately: nothing in it knows about the graph. The `dune_process`
view is its public face and does make that join, lazily, per query, against a
partial index the node tier keeps.

## Performance

The reference trace throughout is `monorepo.perfetto` — 52 MB gzipped, ~378 MB
raw, ~818k nodes and ~28.8M edges. The figures below are **browser** figures
(Firefox, 2026-09-10, `run-dev-server`), which is what a user actually pays.

### Scale

|                       | Value                                                                 |
| --------------------- | --------------------------------------------------------------------- |
| blob text             | 113.0 MB (dict 57.6, depsets 26.9, rules 15.4, deps 12.3, cores 0.8)  |
| nodes                 | 818,056 — 386,320 rules, 431,736 deps                                 |
| edges                 | 28,849,402 real (28,873,904 slots, 24,502 dangling); 0 dynamic stages |
| lifecycle timing rows | 1,204,322                                                             |
| stored edge-tier rows | 6,326,054 (against 29,619,021 unfactored)                             |
| widest rule           | 39,499 static deps                                                    |

### Cost

| Phase                                        | Browser    |
| -------------------------------------------- | ---------- |
| trace load (before the plugin does anything) | ~60 s      |
| blob parse + link                            | 4.6 s      |
| node tier                                    | 57.1 s     |
| edge tier                                    | 33.2 s     |
| **whole load**                               | **95.0 s** |
| wasm heap at the end                         | 4,533.9 MB |

The largest single phase is `lifecycle: pair in SQL` at **~28%** of the load,
followed by `sql: insert _dune_depset_add` (16.4%),
`sql: index the reverse path` (9.1%), `sql: insert _dune_node` (6.0%) and
`sql: insert dune_string` (5.8%). Nothing is unaccounted for beyond 0.1%.

At 4.5 GB the monorepo trace is **memory64-only**: a memory32 browser cannot
load it at all, whatever the plugin does. `memory64Supported()` compiles a probe
module at runtime and there is no silent fallback — a browser without it throws.

### What the caps protect

- **Factoring the edge tier is the single biggest win in the plugin.** On
  identical input the edge tier went from 114.3 s / 2,906 MB / 29.6M rows to
  18.9 s / 1,530 MB / 6.33M rows (harness figures; the browser ratio is roughly
  2x on both). The cost is a bare `count(*) FROM dune_edge`, which went from 0
  to 17.5 s — SQLite does not elide the compound view's unused columns for a
  full scan. Bounded and one-hop queries are unaffected.
- **`NODE_GRAPH_MAX_NODES = 400`** (`explorer/node_graph_source.ts`) is what the
  node graph chart will draw at once, and since it draws all or none, the most a
  query may name. Three things agree on a few hundred: the geometry (a rank is a
  row of dots 36 layout units apart against a 20-units-per-pixel max zoom, so
  ~440 fit an 800px card), the redraw (every node is a `<circle>` and every edge
  a `<line>`, rebuilt as vnodes and diffed on every frame of a pan), and
  legibility (`views/graph_layout.ts` has no crossing reduction, so a rank of
  `k` draws up to `k(k-1)/2` crossings). It is all-or-nothing because a graph
  drawn from part of what was asked for is not a thinner answer, it is a wrong
  one.
- **The directory chart deliberately has no cap.** Its `GROUP BY` collapses any
  input to at most two rows per directory before anything leaves the engine, so
  its tree is bounded by `dune_dir` (~19k rows) rather than by the query.
- **`MEMBER_PAGE = 500` / `INLINE_MEMBER_LIMIT = 20`** (`model/dir_explorer.ts`)
  page the directory explorer. Expanding a directory is at most two index
  probes; nothing there recurses or scans. The one recursion, `compressedDirs`,
  follows single-child directories downwards and stops at the first with
  anything of its own to show, so it visits at most one row per level and never
  fans out.

### Instrumentation

`perf.ts`. A `PerfRun` accumulates a flat list of named phases (`ms`, rows,
bytes, heap delta) and dumps them as a console table when the run finishes.
Phases are flat, not nested, so they sum to just under the run's wall clock and
the dump makes the residue explicit as an `(unaccounted)` row. Each phase also
emits a `performance.measure()` under a `dune:` prefix, so the profiler's
Timings track — and `performance.getEntriesByType('measure')` — keep the timings
after the console table has scrolled away; nothing is retained on this side to
re-print. Heap deltas are Chrome-only and are deltas _across_ a phase, so a
mid-phase GC reads negative — treat them as a hint about steady-state growth,
not an allocation count.

## Gotchas

The ones a _user_ can trip over are in
[README.md](README.md#traps-worth-knowing). These are the internal ones.

- **`dune_dir` compression re-keys rows.** The explorer collapses single-child
  runs, so a row is identified by the _deepest_ directory of the run it
  swallowed. An id that named a row before a filter can name a swallowed
  directory after it — see `rowIdFor` in `views/dir_filter.ts`.
- **`subtreeDirIds` returns only directories that hold rows.** So brushing a
  directory whose own members are all deeper persists the same id set as
  brushing the deepest one that has them, and the recovery then names the deeper
  one. Same rows narrowed; the pressed row can differ from the one clicked.
- **`forcedBy` is not an edge set.** On the monorepo trace 45,503 of 818,035
  recorded node-forcers name a pair that is not an edge at all, so
  `_dune_forced_edge` has to be built by a CSR pass, not from the forcer column.
- **jsdom 25 has no `PointerEvent`.** The graph pane's tests synthesise a
  `MouseEvent` of the right type with a `pointerId`, and stub in the missing
  pointer-capture methods — see `views/graph_panel_unittest.ts`.
- **jsdom has no `performance.measure`.** `perf.ts` feature-detects it.
- **A `sql_source` node's columns are discovered by running it**, and a Data
  Explorer dashboard item renders nothing until its source reports columns. That
  is why every appended source is a two-node chain
  (`sql_source -> modify_columns`) rather than the obvious single node: a
  `modify_columns` node's columns come from its _serialized_ state, so they are
  known the instant the graph loads. See `explorer/explore_source.ts`.
- **A value-based DataGrid renderer may read only its own cell value.**
  `SQLDataSource` only SELECTs the columns the grid's model shows, so a hidden
  sibling column is simply absent from the row, and the grid's added columns are
  keyed by uuid rather than name. A node id is self-sufficient, which is what
  makes `views/node_cell.ts` work at all.

## Testing

```sh
# from the repo root
ui/node_modules/.bin/tsc -p ui/tsconfig.json --noEmit
ui/node_modules/.bin/vitest run src/plugins/com.karmios.nat.DuneGraph --config ui/vitest.config.mjs
cd ui && node_modules/.bin/eslint src/plugins/com.karmios.nat.DuneGraph
cd ui && node_modules/.bin/prettier --check src/plugins/com.karmios.nat.DuneGraph
```

**622 tests across 33 files** as of 2026-09-11.

`docs_unittest.ts` is the other structural test beside `layering_unittest.ts`:
it checks that every `README.md, "X"` / `ARCHITECTURE.md, "X"` pointer in the
sources names a heading that exists, and that neither file has a dangling anchor
link. Rename a heading here and it fails.

`model/graph_test_helper.ts` builds small graphs and controllers for the tests
that need one. `layering_unittest.ts` is not a test of behaviour: it reads the
plugin's own directory, parses the relative imports, and fails on an upward edge
against the layer table below — with a small allowlist of edges that are
deliberate.

What the suite does **not** cover:

- No diff test touches `dune_process`, or any of the mirror. The SQL is
  exercised only through unit tests of the _generated strings_, not by running
  them — there is no trace processor in a unit test.
- `explorer/data_explorer_handoff.ts` has no test at all. (The payload it hands
  over, `explore_source.ts`, is tested against the Data Explorer's own
  validators, which is where a typo would otherwise become a silently dropped
  node rather than a compile error.)

## Loose ends

Things known to be imperfect, kept here so they are not rediscovered:

- **`ChartRenderContext.brushFilters` is populated only on the dashboard path**,
  so a Dune directory chart on a visualisation node cannot recover its brush
  after a reload.
- **The filtered-tree row remap covers the filtered tree only.** The unfiltered
  pane compresses runs too, so a brush taken while filtered and read with the
  filter cleared can still land on a swallowed directory. The clean fix is a
  `rowIdFor` on `DirExplorerSource` so both paths ask one seam.
- **`DirExplorerPanel.reset()` leaves `roots === undefined`**, so between a
  reset and the re-apply landing, `renderBody` issues a `rootDirs()` query the
  filtered pane never reads. Pre-existing.
- **`AccordionAttrs.key`** (`ui/src/widgets/accordion.ts`) is declared and
  passed by nobody. Upstream code, so it is recorded in `UPSTREAM.md` rather
  than deleted here.
- **Three `controller -> views/*` import edges remain allowlisted** in
  `layering_unittest.ts`, all for timeline registration. Emptying them means
  moving timeline-workspace ownership out of the controller, which is a design
  change rather than a cleanup.
- **`sql_formatter.ts` caches a rejected promise for the session**, and
  `views/graph_panel.ts` leaks a `ResizeObserver`. Both low severity, both
  untouched.
