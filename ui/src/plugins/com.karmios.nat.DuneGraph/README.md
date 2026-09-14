# DuneGraph

A Perfetto UI plugin that explores the **build graph of a Dune build**, read out
of a Dune trace.

Dune can be asked to record a trace that carries, on top of the ordinary slices,
a serialised copy of the build graph itself. This plugin reads that graph,
mirrors it into the trace processor's SQL engine, and gives you four ways to
look at it: a side panel, a timeline projection, a SQL query page, and a pair of
Data Explorer chart types.

The plugin id is `com.karmios.nat.DuneGraph`. Everything it adds to SQL is
prefixed `dune_`.

> Working on the plugin rather than using it?
> **[ARCHITECTURE.md](ARCHITECTURE.md)** is the engineering half: the code
> layout, the graph model, the blob format, the SQL mirror's shape, and the
> measurements behind every limit below. [UPSTREAM.md](UPSTREAM.md) is the
> ledger of what the plugin needed from the rest of the UI.

## Contents

1. [Recording a trace](#recording-a-trace)
2. [What it shows](#what-it-shows)
3. [Loading the graph](#loading-the-graph)
4. [The SQL surface](#the-sql-surface)
5. [Limits you can hit](#limits-you-can-hit)
6. [Traps worth knowing](#traps-worth-knowing)

---

## Recording a trace

Graph tracing is not on by default. Set `DUNE_TRACE=+graph` for the build you
want to capture, which adds the `graph` category to whatever dune would
otherwise record:

```sh
$ DUNE_TRACE=+graph dune build @install
$ dune trace perfetto | gzip > build.perfetto.gz
```

The first command leaves a `_build/trace.csexp`; the second converts it to the
Perfetto format this plugin reads, writing to stdout when given no `-o`. Open
`build.perfetto.gz` in the UI as normal — it reads gzipped traces directly, and
the graph is carried as text, so the pipe is well worth it: the reference
monorepo trace is 378 MB raw and 52 MB gzipped.

A trace recorded without `+graph` still loads — it just has no build graph in
it, and the plugin says so rather than showing an empty tree.

## What it shows

### The side panel

Two tabs, **Dune** and **Explorer**.

**Dune** is the node-centric view. It shows the build-graph node behind whatever
is selected on the timeline — what the rule actually ran, what depends on it,
and what it depends on, the last two as trees grouped by path. Under that sits
the set of nodes you have collected, drawn as a layered node graph you can pan
and zoom. Every node in the UI carries a ＋/－ toggle that adds it to or removes
it from that set.

**Explorer** is the same graph seen as _directories_: the build's directory
hierarchy, descended one level at a time, with each directory's rules and
dependencies hanging off it. This is the view for when you do not yet know which
node you are looking for. It has its own path filter and a Filters menu for
narrowing by outcome, resolution, status or duration.

### The timeline

`Dune graph` is a workspace of four tracks — `dep`, `rule`, `rule-action` and
`process` — projecting the nodes you have collected onto the timeline, so you
can see when each one actually happened. Selecting a row draws arrows to
everything in its family: the dep that resolved to a rule, that rule's action,
and the processes the action spawned.

The graph pane's "Timeline" button switches to it; the ordinary workspace
switcher gets you back.

### The query page

SQL over the mirror, in two places:

- The **`@` omnibox mode** (or `Dune: query graph`) opens a details-drawer tab —
  the fast one-off lookup next to the timeline you are already reading.
- The **full page** at `#!/dune_query`, from the sidebar or
  `Dune: open query page`, gives you a strip of editor tabs each with its own
  buffer and results, a query history, and a **Tables** sidebar documenting
  every `dune_*` table, function and macro with an example query. It can
  remember your tabs across reloads — off by default, under
  `Dune graph: remember query page tabs (experimental)`; it stores your SQL,
  never your results.

Results are node-aware wherever a column holds a node: a `node_id`, `src` or
`dst` cell draws a coloured kind chip, a label linking to that node's slice on
the timeline, and the ＋/－ toggle. There is a tree mode that groups the result
by path.

### Data Explorer

Two **chart types** to drop onto a query or a dashboard:

- **Dune Directories** (`dune-dir-tree`) draws your query's rows as the part of
  the build's directory tree they landed in. Clicking a directory's filter
  button narrows every other card on the dashboard to that subtree.
- **Dune Node Graph** (`dune-node-graph`) draws them as the build graph between
  them — the same pane the side panel uses, over the nodes a query named rather
  than the ones you clicked.

Both read their primary column as _the column holding a `dune_node.node_id`_,
and both offer to switch to the right column if you have picked another one.

The side panel also offers `dune_dir` and `dune_node` as **data sources** to
append to the graph you are building in the Data Explorer. Those buttons appear
only while the Data Explorer is the open page.

## Loading the graph

Most traces load themselves: open one and the graph is there. Reading the graph
does cost real time, though — minutes on a very large build — so the plugin
sizes the job up first and only gets on with it when the answer is small enough.
Past that it leaves the side panel showing what a load would involve, and waits
for you to press **Load graph**.

Where that line falls is yours to set:
**`Dune graph: load without asking below (edge rows)`** in the settings,
2,000,000 by default. Set it to `0` to be asked every time, or to something
enormous never to be asked at all; it takes effect the next time you open a
trace. The estimate it is compared against comes from the size of the graph in
the trace rather than from reading it, so it is available before anything
expensive happens — and saying yes buys the whole load, so you are not stopped
and asked again partway through.

The one thing you cannot ask for is a build past **100,000,000 edges**: the edge
tables are not built at that size, because materialising them would exhaust the
trace processor. The panel says so when it happens, and everything except
`dune_edge` and the relation functions still works.

While loading, the panel lists and checks off each step, so a minutes-long build
shows what is left rather than only what it is doing now. Each load also prints
a per-phase breakdown to the devtools console when it finishes, and leaves
`dune:`-prefixed entries in the profiler's Timings track.

A half-built graph is a **usable** state everywhere: the timeline tracks come
back empty, the query surfaces refuse up front and name the command that would
fix it, and the panel keeps working. `Dune: load build graph` and
`Dune: reload build graph` do it by hand; `Dune: materialise edge table` is the
way back if the edge tier alone failed.

## The SQL surface

The **Tables** sidebar on the query page is the reference — every table,
function and macro with its columns described and an example query to run. In
short:

| Table               | Is                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `dune_node`         | One row per node. Identity, slice, forcing, timing, `dir_id` — everything meaningful for _every_ node. |
| `dune_rule`         | Per-rule detail: `outcome`, action slice/ts/duration, target and dep counts, `deps_unknown`.           |
| `dune_dep`          | Per-dep detail: `path`, `resolution`, `status`, `resolved_rule_node_id`, `is_source`.                  |
| `dune_rule_target`  | A rule's output targets, one row per target.                                                           |
| `dune_dir`          | The directory hierarchy, with per-directory and whole-subtree rollups and duration sums.               |
| `dune_gen_rules`    | One row per directory dune generated rules for: the span's ts and duration, and the `dune` file.       |
| `dune_dyn_includes` | One row per `dynamic-includes` span: a `dune` file dune had to generate before it could read it.       |
| `dune_edge`         | Directed edges, "source depends on dest", tagged `static` / `dynamic` / `resolved` / `expanded`.       |
| `dune_edge_blocked` | `dune_edge` plus `blocked_ns`: how much of `src`'s span `dst` accounts for.                            |
| `dune_process`      | One row per spawned process: its slice, `ts`/`dur`, and the rule that forced it.                       |
| `dune_string`       | The intern table — every path the graph mentions. `WHERE str GLOB '*.cmi'` is a fast way in.           |

Plus eight relation functions, forward and reverse, bounded and unbounded,
all-edges and forced-only:

```sql
-- dune_descendants(node_id, max_steps, step_kind)
-- Everything this rule transitively needs, at most 3 hops out.
SELECT * FROM dune_descendants(42, 3, NULL);
-- Everything that depends on it, unbounded and cycle-safe.
SELECT * FROM dune_all_ancestors(42);
-- One hop either way.
SELECT * FROM dune_children(42);
SELECT * FROM dune_parents(42);
-- What pulled it into the build, and what it pulled in.
SELECT * FROM dune_forcers(42);
SELECT * FROM dune_forced(42);
```

`max_steps` bounds the walk (`NULL` for unbounded) and `step_kind` restricts
which node kinds a step may pass through (`'rule'`, `'dep'`, or `NULL` for
either). Each has a `!()` form taking a table of start nodes instead of one, and
`dune_blocked!(edges)` appends blocked time to anything with `src` / `dst`
columns.

Any grid in the UI — not just this plugin's — renders a column typed
`JOINID(dune_node.node_id)` as a Dune node chip, so a query you take elsewhere
keeps its node links.

## Limits you can hit

- **The node graph chart draws at most 400 nodes**, all or nothing: a query
  naming more is refused rather than drawn in part, and says how many it found.
  Narrow the query and the graph of what is left will be readable too.
- **A very large trace may need a 64-bit browser.** The reference monorepo trace
  peaks at ~4.5 GB and cannot be loaded by a 32-bit wasm build at all, whatever
  the plugin does.

## Traps worth knowing

- **`dur_ns` is NULL, never `-1`.** Perfetto stores an unfinished slice's
  duration as `-1`; the mirror normalises that away, so a node whose span never
  ended has no duration rather than a negative one. If you read a raw
  `slice.dur` yourself, do the same.
- **Do not sum `blocked_ns` over a node's edges.** Dependencies build in
  parallel, so their waits overlap and adding them double-counts — a rule
  blocked for 1 s on ten concurrent deps sums to 10 s. `max(blocked_ns)` is the
  honest per-node figure.
- **A `dune_dir` row need not hold anything.** Every directory dune ran
  `gen-rules` for gets a row, and on a large build about half of those hold no
  rule and no dep anywhere beneath them — generated output trees such as `.bin`
  and `.utop`. `n_gen_rules` / `t_gen_rules` is how you tell them apart:
  `t_rules = 0 AND t_deps = 0 AND t_gen_rules > 0` is exactly the
  generated-but-empty set.
- **`dune_node.dir_id` and `orig_id` are not node ids.** `dir_id` indexes
  `dune_dir` and `orig_id` is the trace-side id dune used; both collide with
  unrelated `node_id`s by construction, so joining either to `dune_node.node_id`
  gives you nonsense rather than an error.
