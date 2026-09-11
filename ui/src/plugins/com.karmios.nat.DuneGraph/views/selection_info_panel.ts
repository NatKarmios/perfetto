// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {Icons} from '../../../base/semantic_icons';
import {Anchor} from '../../../widgets/anchor';
import {Button} from '../../../widgets/button';
import {Icon} from '../../../widgets/icon';
import {EmptyState} from '../../../widgets/empty_state';
import {MenuItem, PopupMenu} from '../../../widgets/menu';
import {Accordion, AccordionSection} from '../../../widgets/accordion';
import type {DuneGraphController} from '../controller';
import type {
  ForcedBy,
  GraphNode,
  NodeId,
  NodeKind,
  NodeTiming,
  OutRef,
} from '../model/graph';
import {
  basename,
  decorateDepPath,
  decorateNode,
  depResolutionLabel,
  depStatusLabel,
  forcedByText,
  formatDurNs,
  kindChip,
  nodePathParts,
  outcomeLabel,
} from './node_display';
import {
  groupBulkActions,
  nodesInGroup,
  nodeToggleButton,
} from './node_tree_actions';
import type {ProcessDetails} from '../sql/process_sql';
import type {PathTreeItem, PathTreeLeaf} from '../model/path_tree';
import {buildPathTree} from '../model/path_tree';
import {PathTreeView} from './path_tree_view';

interface SelectionInfoPanelAttrs {
  readonly controller: DuneGraphController;
}

// One entry in the dependencies / dependants lists: a referenced node (absent
// for a reference the blob never recorded a node for), the kind it stands for (so
// the kind chip renders even then), its display label, the directory it files
// under in the path tree (a rule's `dir`; a dep's label is itself a path), an
// optional chip marking a special edge kind (dynamic dep), and whether the edge
// is forced. `OutRef` (see graph.ts) is this shape plus the edge kind it was
// derived from.
interface Ref {
  readonly kind: NodeKind;
  readonly label: string;
  readonly dir?: string;
  readonly node?: NodeId;
  readonly chip?: string;
  readonly forced: boolean;
}

/**
 * Details for the node behind the current timeline selection, or an empty state
 * when the selection is not one of ours. Reads the selection off the controller
 * each render, since selection is poll-based.
 *
 * Three accordion sections, `processes` leading: what the rule actually _ran_
 * is the concrete answer, where `dependants` and `dependencies` are for
 * navigating outwards from it. Those two are each a union of the node's own
 * referenced ids and the graph's accrued edges, forced edges marked by icon.
 */
export class SelectionInfoPanel implements m.ClassComponent<SelectionInfoPanelAttrs> {
  // Collapse state for the dependants/dependencies path-tree groups, keyed by
  // `${title}:${group.path}` so the same directory in each list folds
  // independently. Reset whenever the selection changes (the panel is
  // re-rendered on a selection poll rather than remounted, so this can't just
  // live in the constructor).
  private collapsed = new Set<string>();
  // Disclosure state for the processes list, keyed `proc:<sliceId>` /
  // `proc-args:<sliceId>`. A second set rather than more keys in `collapsed`
  // because it defaults the other way round: a directory group is open until
  // folded, while a process entry is *closed* until opened - a rule's few
  // processes read as a list of command lines, and the full path / cwd / argv
  // behind each are what you go looking for. Reset with `collapsed`, and for
  // the same reason.
  private expanded = new Set<string>();
  private selectionKey?: string;
  // The selected node's timing, which lives in SQL rather than on the node
  // (see lifecycle_sql.ts) and so has to be fetched. Keyed by the node *and*
  // whether the mirror that answers the query exists yet, so a selection made
  // mid-load picks its timing up as soon as the mirror lands.
  private timingKey?: string;
  private timing?: NodeTiming;
  // The processes the selected rule spawned, fetched and keyed exactly like the
  // timing above (and undefined for a dep, which forces no process - a process
  // names the rule that pulled it in and nothing else).
  private processesKey?: string;
  private processes?: readonly ProcessDetails[];

  view({attrs}: m.CVnode<SelectionInfoPanelAttrs>): m.Children {
    const {controller} = attrs;
    const selected = controller.nodeForSelection();
    if (selected === undefined) {
      this.collapsed.clear();
      this.expanded.clear();
      this.selectionKey = undefined;
      return m(EmptyState, {
        icon: 'info',
        title: 'Select a build-dep or exec-rule slice',
      });
    }
    const selectionKey = String(selected);
    if (selectionKey !== this.selectionKey) {
      this.collapsed.clear();
      this.expanded.clear();
      this.selectionKey = selectionKey;
    }
    this.fetchTiming(controller, selected, selectionKey);
    // The one place a node view is materialised: the header and its muted
    // lines below want every scalar the node has, and there is exactly one of
    // them on screen (see graph.ts's GraphNode).
    const node = controller.graph.node(selected);
    this.fetchProcesses(controller, node, selectionKey);
    const dependants = this.dependants(controller, selected);
    return m(
      '.pf-dune-graph__info',
      this.renderHeader(controller, node),
      this.renderDir(controller, node),
      this.renderAction(node),
      this.renderForcedBy(controller, node, dependants),
      m(
        Accordion,
        {multi: true},
        // Keyed, and the holes filtered out: the Processes section comes and
        // goes (rules only, and only once its query lands), so without keys
        // mithril would match an `AccordionSection` to whichever section now
        // sits in its old position and hand it that one's open/closed state.
        [
          this.renderProcesses(controller),
          this.renderRefs(controller, 'Dependants', dependants),
          this.renderRefs(
            controller,
            'Dependencies',
            this.dependencies(controller, selected),
          ),
        ].filter((section) => section !== undefined),
      ),
    );
  }

  // Starts a timing fetch when the panel is showing a node whose timing it
  // hasn't got, and asks for a redraw once it lands. Called from `view`, so it
  // must be a no-op for a node already fetched.
  private fetchTiming(
    controller: DuneGraphController,
    node: NodeId,
    selectionKey: string,
  ): void {
    const key = `${selectionKey}|${controller.nodeMirrorReady}`;
    if (this.timingKey === key) return;
    this.timingKey = key;
    this.timing = undefined;
    void controller.timingFor(node).then((timing) => {
      if (this.timingKey !== key) return; // selection moved on meanwhile
      this.timing = timing;
      controller.requestRedraw();
    });
  }

  // The same shape as fetchTiming(), for the selected rule's processes. A dep
  // is short-circuited here rather than in the controller so that the key still
  // moves with the selection - otherwise a dep selected after a rule would keep
  // showing the rule's processes.
  private fetchProcesses(
    controller: DuneGraphController,
    node: GraphNode,
    selectionKey: string,
  ): void {
    const key = `${selectionKey}|${controller.nodeMirrorReady}`;
    if (this.processesKey === key) return;
    this.processesKey = key;
    this.processes = undefined;
    if (node.kind !== 'rule') return;
    void controller.processesForRule(node.nodeId).then((processes) => {
      if (this.processesKey !== key) return; // selection moved on meanwhile
      this.processes = processes;
      controller.requestRedraw();
    });
  }

  private renderHeader(
    controller: DuneGraphController,
    node: GraphNode,
  ): m.Children {
    // The node id is always known, but it's only useful as a cross-reference
    // once the tables the `dune_*` functions read exist.
    const nodeId = controller.nodeMirrorReady ? node.nodeId : undefined;
    // A dep's path gets the leading build/code icon (its `_build/<dir>/` prefix
    // folded into the icon tooltip); a rule shows its bare id. The full,
    // undecorated label stays available on the title's hover tooltip.
    const label = node.label;
    const {icon, text} = decorateNode(controller.graph, node.nodeId);
    return m(
      '.pf-dune-graph__info-header',
      m(
        'span.pf-dune-graph__info-main',
        kindChip(node.kind, controller.graph.healthOf(node.nodeId)),
        icon,
        m(
          'span.pf-dune-graph__info-title',
          {title: label},
          m(
            'span.pf-dune-graph__info-title-text',
            m('span.pf-dune-graph__info-title-bidi', text),
          ),
        ),
        this.renderStatus(node),
      ),
      m(
        'span.pf-dune-graph__info-actions',
        // The dense SQL node_id, unintrusive - a cross-reference for the
        // dune_* relation functions in the query tab.
        nodeId !== undefined &&
          m(
            'span.pf-dune-graph__info-nodeid',
            {
              title:
                'node_id — pass to dune_descendants() / dune_ancestors() / ' +
                'dune_children() / dune_parents() / dune_forcers() / ' +
                'dune_forced()',
            },
            `#${nodeId}`,
          ),
        this.renderAddMenu(controller, node.nodeId),
      ),
    );
  }

  // Dropdown to add the node - or one of its relations - to the graph
  // selection. "Parents"/"ancestors" are nodes that directly/transitively
  // depend on this one; "children"/"descendants" are nodes it directly/
  // transitively depends on; "forcers" is the chain of nodes that transitively
  // forced this one into the build. Every option adds the current node itself
  // alongside the relation, so the added nodes stay connected to something
  // already visible.
  private renderAddMenu(
    controller: DuneGraphController,
    node: NodeId,
  ): m.Children {
    return m(
      PopupMenu,
      {
        trigger: m(Button, {
          label: 'Add to graph',
          icon: 'account_tree',
          rightIcon: Icons.ContextMenu,
        }),
      },
      this.addMenuItem(controller, node, 'This node', 'add', () => []),
      this.addMenuItem(controller, node, 'Parents', 'arrow_upward', () =>
        controller.parentsOf(node),
      ),
      this.addMenuItem(controller, node, 'Children', 'arrow_downward', () =>
        controller.childrenOf(node),
      ),
      this.addMenuItem(
        controller,
        node,
        'Ancestors',
        'keyboard_double_arrow_up',
        () => controller.ancestorsOf(node),
      ),
      this.addMenuItem(
        controller,
        node,
        'Descendants',
        'keyboard_double_arrow_down',
        () => controller.descendantsOf(node),
      ),
      this.addMenuItem(controller, node, 'Forcers', 'priority_high', () =>
        controller.forcersOf(node),
      ),
    );
  }

  // One "Add to graph" menu item: adds `node` plus whatever `related` returns.
  // `related` is only called on click, since some relations (e.g. descendants
  // of a hot node) can be expensive to walk.
  private addMenuItem(
    controller: DuneGraphController,
    node: NodeId,
    label: string,
    icon: string,
    related: () => readonly NodeId[],
  ): m.Children {
    return m(MenuItem, {
      label,
      icon,
      onclick: () => controller.addToGraph([node, ...related()]),
    });
  }

  // A rule's context directory (`dune.dir`), as a muted line under the header.
  // Absent for deps and for rules that didn't record one.
  private renderDir(
    controller: DuneGraphController,
    node: GraphNode,
  ): m.Children {
    if (node.kind !== 'rule') return undefined;
    const dir = node.dir;
    if (dir === undefined) return undefined;
    const {icon, text} = decorateDepPath(dir, controller.graph.buildRoots);
    return m(
      '.pf-dune-graph__dir',
      {title: dir},
      m('span.pf-dune-graph__dir-label', 'dir'),
      icon,
      text,
    );
  }

  // The header's status chip: how the node resolved (a rule's outcome, or a
  // dep's resolution) plus its span duration, and a `×N` hint when the span
  // was seen more than once (watch mode, or a dep built more than once - see
  // `SpanTiming.occurrenceCount`). The duration/`×N` half appears once the
  // timing query lands (and not at all for a node no lifecycle instant
  // resolved to); the resolution half comes off the node and is always there.
  //
  // A dep also carries how its own build ended, which is orthogonal to what it
  // resolved to (so "built · failed" is a real combination), and a rule whose
  // deps dune couldn't determine says so - otherwise it reads as a rule with no
  // deps, which is a different fact about the build.
  private renderStatus(node: GraphNode): m.Children {
    const label =
      node.kind === 'rule'
        ? outcomeLabel(node.outcome)
        : depResolutionLabel(node.resolution);
    const note =
      node.kind === 'rule'
        ? node.depsUnknown
          ? 'deps unknown'
          : undefined
        : depStatusLabel(node.status);
    const durNs = this.timing?.timing?.durNs;
    const occurrences = this.timing?.timing?.occurrenceCount;
    return m(
      'span.pf-dune-graph__status',
      m('span.pf-dune-graph__status-label', label),
      note !== undefined && m('span.pf-dune-graph__status-label', note),
      durNs !== undefined &&
        m('span.pf-dune-graph__status-dur', formatDurNs(durNs)),
      occurrences !== undefined &&
        occurrences > 1 &&
        m(
          'span.pf-dune-graph__status-occ',
          {
            title: `Seen ${occurrences} times, e.g. across watch-mode iterations`,
          },
          `×${occurrences}`,
        ),
    );
  }

  // An executed rule's action interval, as a muted line under `dir` - "action
  // in flight" per the dune doc, not worker occupancy: it includes scheduler
  // queue wait and isn't bounded by `-j` (see `RuleNode.actionTiming` in
  // graph.ts). Absent for a cache hit (no action ran) or one that never
  // resolved a duration.
  private renderAction(node: GraphNode): m.Children {
    if (node.kind !== 'rule') return undefined;
    const durNs = this.timing?.actionTiming?.durNs;
    if (durNs === undefined) return undefined;
    return m(
      '.pf-dune-graph__action',
      {
        title:
          'Time the action was in flight, including scheduler queue wait - ' +
          'not bounded by -j, so not the same as worker occupancy.',
      },
      m('span.pf-dune-graph__dir-label', 'action'),
      formatDurNs(durNs),
    );
  }

  // The node's `dune.forced_by`, as a muted line under the header. The forcer
  // kinds that name a node (RULE, RULE_RECOVERY, DEP) link to that node's slice
  // (like other referenced ids) when it's in the graph; the rest are
  // descriptive text.
  //
  // Such a forcer is itself a dependant (the forced edge points from it into
  // this node), so it already appears - marked as forced - in the Dependants
  // list; we only surface this explicit line when the forcer isn't in that list
  // (a non-node kind, or a reference the blob never recorded a node for).
  private renderForcedBy(
    controller: DuneGraphController,
    node: GraphNode,
    dependants: readonly Ref[],
  ): m.Children {
    const fb = node.forcedBy;
    if (fb === undefined || forcerInList(fb, dependants)) return undefined;
    return m(
      '.pf-dune-graph__forced-by',
      'Forced by ',
      this.forcedByContent(controller, fb),
    );
  }

  // Phrasing comes from `forcedByText` (shared with the query tab's tree
  // extras); only the node-naming kinds additionally get linked to their node
  // here, since the query tab has no node to link to for a plain SQL column.
  // The link is keyed on `fb.node`, so a new node-naming kind needs nothing
  // here beyond its phrasing.
  private forcedByContent(
    controller: DuneGraphController,
    fb: ForcedBy,
  ): m.Children {
    const text = forcedByText(fb.kind, fb.target) ?? 'an unknown source';
    return nodeLink(controller, fb.node, text);
  }

  // Groups `refs` into a path tree (deps by their id, rules by their `dir`)
  // and renders it inside the accordion section; nesting only appears where a
  // directory actually holds two or more rows.
  private renderRefs(
    controller: DuneGraphController,
    title: string,
    refs: readonly Ref[],
  ): m.Children {
    const tree = buildPathTree(refs.map(refPathItem));
    return m(
      AccordionSection,
      {key: title, summary: `${title} (${refs.length})`, defaultOpen: true},
      refs.length === 0
        ? m('.pf-dune-graph__refs-empty', 'None')
        : m(PathTreeView<Ref>, {
            rows: tree,
            // Namespaced per-list so the same directory in Dependants and
            // Dependencies folds independently.
            keyPrefix: title,
            collapsed: this.collapsed,
            onToggleGroup: (key) => {
              if (this.collapsed.has(key)) this.collapsed.delete(key);
              else this.collapsed.add(key);
            },
            renderLeaf: (row) => this.renderRef(controller, row),
            groupActions: (row) =>
              groupBulkActions(controller, nodesInGroup(row)),
          }),
    );
  }

  private renderRef(
    controller: DuneGraphController,
    row: PathTreeLeaf<Ref>,
  ): m.Children {
    const {item: ref, prefix, label} = row;
    return m(
      '.pf-dune-graph__ref',
      // Forced edges lead with an icon.
      ref.forced &&
        m(Icon, {
          icon: 'priority_high',
          title: 'Forced edge',
          className: 'pf-dune-graph__forced-icon',
        }),
      // A reference the blob never recorded a node for has no health to show;
      // leaving it unmarked is the honest rendering.
      kindChip(
        ref.kind,
        ref.node === undefined ? 'ok' : controller.graph.healthOf(ref.node),
      ),
      ref.chip !== undefined &&
        m(
          'span.pf-dune-graph__ref-chip',
          {title: chipTitle(ref.chip)},
          ref.chip,
        ),
      m(
        'span.pf-dune-graph__ref-label',
        prefix !== '' && m('span.pf-dune-graph__ref-prefix', prefix),
        nodeLink(controller, ref.node, label),
      ),
      ref.node !== undefined && nodeToggleButton(controller, ref.node),
    );
  }

  // Rules only, and only when there are any: a dep spawns nothing, and a trace
  // whose dune does not emit the `forced_by` arg has no process slices at all -
  // still the common case, so an empty "Processes (0)" would sit under every
  // rule saying nothing. Absent while the fetch is in flight too, since a rule
  // forces a handful at most and the query is one round trip.
  private renderProcesses(controller: DuneGraphController): m.Children {
    const processes = this.processes;
    if (processes === undefined || processes.length === 0) return undefined;
    // Which entry the reader arrived on, when they got here by clicking a
    // process slice. Read once per render rather than per entry.
    const selectedSlice = controller.selectedProcessSlice();
    return m(
      AccordionSection,
      {
        key: 'processes',
        summary: `Processes (${processes.length})`,
        defaultOpen: true,
      },
      processes.map((p) => this.renderProcess(controller, p, selectedSlice)),
    );
  }

  // One process: a header that is always visible, and a body that isn't. Both
  // halves fold on the panel's own `expanded` set rather than on a nested
  // AccordionSection's component-local state, so that a stale "open" can't leak
  // onto a different rule's entry when mithril reuses the component by position
  // - the set is cleared whenever the selection changes.
  private renderProcess(
    controller: DuneGraphController,
    p: ProcessDetails,
    selectedSlice: number | undefined,
  ): m.Children {
    const key = `proc:${p.sliceId}`;
    const open = this.expanded.has(key);
    return m(
      '.pf-dune-graph__proc',
      m(
        '.pf-dune-graph__proc-header',
        {
          // The slice this panel was reached through, so it is obvious which of
          // the rule's processes you came in on.
          className:
            p.sliceId === selectedSlice
              ? 'pf-dune-graph__proc-header--selected'
              : undefined,
          // The whole command, since the visible text is ellipsised.
          title: commandLine(p),
          onclick: () => this.toggleExpanded(key),
        },
        m(Icon, {
          icon: open ? 'expand_more' : 'chevron_right',
          className: 'pf-dune-tree__group-caret',
        }),
        m('span.pf-dune-graph__proc-command', commandLine(p)),
        p.exitCode !== undefined &&
          p.exitCode !== 0 &&
          m(
            'span.pf-dune-graph__proc-exit',
            {title: `Exited with status ${p.exitCode}`},
            `exit ${p.exitCode}`,
          ),
        p.durNs !== undefined &&
          m('span.pf-dune-graph__status-dur', formatDurNs(p.durNs)),
      ),
      open && this.renderProcessBody(controller, p),
    );
  }

  private renderProcessBody(
    controller: DuneGraphController,
    p: ProcessDetails,
  ): m.Children {
    const buildRoots = controller.graph.buildRoots;
    return m(
      '.pf-dune-graph__proc-body',
      // Ordered by how often it is what you came for: how long it took, what
      // ran, with which arguments - then the two that are usually the same for
      // every process of a build (cwd) or unremarkable (a zero exit).
      p.durNs !== undefined &&
        this.renderProcField('duration', formatDurNs(p.durNs)),
      // The program's full path, decorated the way every other path in this
      // panel is (a build-root prefix folded into an icon tooltip).
      p.prog !== undefined &&
        this.renderProcField('prog', decorated(p.prog, buildRoots)),
      this.renderProcArgs(p),
      p.dir !== undefined &&
        this.renderProcField('dir', decorated(p.dir, buildRoots)),
      p.exitCode !== undefined &&
        this.renderProcField('exit', String(p.exitCode)),
      m(
        '.pf-dune-graph__proc-link',
        m(
          Anchor,
          {
            icon: Icons.UpdateSelection,
            title: 'Select on the timeline',
            onclick: () => void controller.goToProcessSlice(p.sliceId),
          },
          'Go to slice',
        ),
      ),
    );
  }

  // One `label: value` line of a process's body, matching the muted `dir` /
  // `action` lines under the panel header.
  private renderProcField(label: string, value: m.Children): m.Children {
    return m(
      '.pf-dune-graph__proc-field',
      m('span.pf-dune-graph__dir-label', label),
      m('span.pf-dune-graph__proc-value', value),
    );
  }

  // The process's argv, itself collapsible: one argument per line, which is the
  // only readable form for the long ones (up to ~90 arguments on a real build,
  // several of them paths). Absent for a program invoked with none.
  private renderProcArgs(p: ProcessDetails): m.Children {
    if (p.args.length === 0) return undefined;
    const key = `proc-args:${p.sliceId}`;
    const open = this.expanded.has(key);
    return m(
      '.pf-dune-graph__proc-args',
      m(
        '.pf-dune-tree__group-header',
        {onclick: () => this.toggleExpanded(key)},
        m(Icon, {
          icon: open ? 'expand_more' : 'chevron_right',
          className: 'pf-dune-tree__group-caret',
        }),
        `args (${p.args.length})`,
      ),
      open &&
        m(
          '.pf-dune-graph__proc-arg-list',
          p.args.map((arg) => m('.pf-dune-graph__proc-arg', arg)),
        ),
    );
  }

  // Flips one `expanded` key. The mirror image of the path tree's
  // `onToggleGroup`, which flips a `collapsed` one - see `expanded`'s comment
  // for why the processes list defaults the other way.
  private toggleExpanded(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
  }

  // Nodes this one depends on (its outgoing edges): a rule's static + dynamic
  // deps, a dep's resolved rule + expanded deps. All of them are the node's own
  // out-edges, dynamic ones chipped `DYN`; a reference the blob never recorded a
  // node for shows as a plain unlinked entry.
  private dependencies(controller: DuneGraphController, node: NodeId): Ref[] {
    return [...controller.graph.outRefs(node)].map(refOf);
  }

  // Nodes that depend on this one (its incoming edges): the graph's reverse
  // edges, unioned with a rule's declared targets (which depend on the rule to
  // be produced). A target with no reverse edge yet is still listed (unlinked if
  // it isn't a known node).
  private dependants(controller: DuneGraphController, node: NodeId): Ref[] {
    const graph = controller.graph;
    const refs: Ref[] = [];
    for (const parent of controller.parentsOf(node)) {
      refs.push({
        kind: graph.kindOf(parent),
        label: graph.labelOf(parent),
        dir: graph.dirOf(parent),
        node: parent,
        forced: graph.forcerOf(node) === parent,
      });
    }
    if (graph.isRule(node)) {
      // A rule's declared targets depend on it to be produced, so they belong
      // in this list - but a target is a *path* (its `dir` joined onto a
      // relative name), not a dict id, so it can't be resolved back to a dep
      // node by id. Dedup against the dep dependants' paths and list what's
      // left as a plain unlinked row. In practice a target that is a known dep
      // node is already a dependant: that dep resolves to this rule, which is
      // exactly a reverse edge into it.
      const paths = new Set(
        refs.filter((r) => r.kind === 'dep').map((r) => r.label),
      );
      for (const {path} of graph.ruleTargets(node)) {
        if (paths.has(path)) continue;
        paths.add(path);
        refs.push({kind: 'dep', label: path, forced: false});
      }
    }
    return refs;
  }
}

// A dependency row for one of a node's out-edges: the same fields, plus the
// `DYN` chip a dynamic dep gets (an expanded dep gets none - the parent dep's
// own status chip already says it expanded).
function refOf(ref: OutRef): Ref {
  return {
    kind: ref.kind,
    label: ref.label,
    dir: ref.dir,
    node: ref.node,
    chip: ref.edgeKind === 'dynamic' ? 'DYN' : undefined,
    forced: ref.forced,
  };
}

// Human-readable tooltip for a ref chip (only DYN - dynamic deps - today).
function chipTitle(chip: string): string {
  return chip === 'DYN' ? 'Dynamic dependency' : chip;
}

// Whether a forcer is already represented as a node in the dependants list.
// Only the RULE/DEP kinds name a node at all, and only when the blob recorded
// one, so anything else is never in the list.
function forcerInList(fb: ForcedBy, dependants: readonly Ref[]): boolean {
  return fb.node !== undefined && dependants.some((r) => r.node === fb.node);
}

// Render `label` as a link that navigates to `node`'s slice, or as plain text
// when `node` is undefined (the referenced id isn't a known graph node - see
// `dangling` in graph.ts).
function nodeLink(
  controller: DuneGraphController,
  node: NodeId | undefined,
  label: string,
): m.Children {
  if (node === undefined) return label;
  return m(Anchor, {onclick: () => void controller.goToNode(node)}, label);
}

// Where a ref files into the path tree: a dep ref's label is itself a path; a
// rule ref files under its node's `dir` field (top-level when unrecorded or
// unset). See `nodePathParts`.
function refPathItem(ref: Ref): PathTreeItem<Ref> {
  const {dir: dirSegs, leaf} = nodePathParts(ref.kind, ref.label, ref.dir);
  return {dir: dirSegs, leaf, item: ref};
}

// A process's command line as one string: the program's *filename* followed by
// its arguments. The program's directory is dropped here (`ocamlc.opt`, not
// `/nix/store/…/bin/ocamlc.opt`) because it is the same for every process of a
// build and would push the arguments - the half that distinguishes one process
// from another - off the end of the line. The full path is in the entry's body,
// and the whole of this string is on the header's tooltip.
//
// Not shell-quoted: an argument is shown as dune passed it, so this reads as a
// command but is not one to paste.
function commandLine(p: ProcessDetails): string {
  const prog = basename(p.prog) ?? 'process';
  return p.args.length === 0 ? prog : `${prog} ${p.args.join(' ')}`;
}

// A path as the rest of the panel renders one: the leading build/code icon with
// any build-root prefix folded into its tooltip, then the remainder.
function decorated(path: string, buildRoots: readonly string[]): m.Children {
  const {icon, text} = decorateDepPath(path, buildRoots);
  return [icon, text];
}
