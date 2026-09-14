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

/**
 * Details for the directory behind the current timeline selection - the
 * directory half of `views/selection_info_panel.ts`, which mounts this when
 * the selection resolved on the second channel (see controller.ts's
 * `dirForSelection`).
 *
 * A `gen-rules` span is a directory's, not a node's, so nothing here is a
 * `GraphNode`: the header is a path off the mirror, the span comes from
 * `dune_gen_rules`, and the two lists below are the directory's children and
 * its members. **ARCHITECTURE.md, "Why it is shaped this way", is why those
 * live in two tables** rather than as more columns on one.
 *
 * Every directory link goes through `dirAnchor`, i.e. back through
 * `goToDir`, so clicking one re-points *this* panel at the directory clicked.
 * That is also the whole of the feedback: inside the Dune workspace the span's
 * own track is not present, so the timeline does not scroll to it - the panel
 * changing is what says the click landed.
 */

import m from 'mithril';
import type {Trace} from '../../../public/trace';
import {Accordion, AccordionSection} from '../../../widgets/accordion';
import {Button} from '../../../widgets/button';
import type {DuneGraphController} from '../controller';
import type {DirDetails, DirEntry, MemberEntry} from '../model/dir_explorer';
import {
  MEMBER_PAGE,
  childDirs,
  dirDetails,
  dirMembers,
} from '../model/dir_explorer';
import {TOP_LEVEL_LABEL, dirPathLabel} from '../model/dir_tree';
import {dirLabel} from './dir_explorer_panel';
import {dirAnchor, renderNodeCell, renderNodeCellActions} from './node_cell';
import {decorateDepPath, formatDurNs} from './node_display';

interface DirInfoPanelAttrs {
  readonly controller: DuneGraphController;
  // For the queries below; everything else this panel shows comes off the
  // controller.
  readonly trace: Trace;
  readonly dirId: number;
}

export class DirInfoPanel implements m.ClassComponent<DirInfoPanelAttrs> {
  // What the three fetches below were made for: the directory, and the mirror
  // generation whose ids it is a directory *of*. A reload renumbers both the
  // directories and the nodes, so everything here has to be thrown away with
  // it (see controller.ts's `mirrorVersion`).
  private key?: string;
  private details?: DirDetails;
  private children?: readonly DirEntry[];
  // Members are count-first: the count is already on the directory's row, and
  // `t_deps` runs to six figures on a real build, so the list is not read until
  // it is asked for. The same rule the Explorer pane follows for the same
  // reason (see ARCHITECTURE.md, "Counts and members are bounded differently,
  // because they are different sizes").
  private members?: readonly MemberEntry[];
  private membersAsked = false;

  view({attrs}: m.CVnode<DirInfoPanelAttrs>): m.Children {
    const {controller, dirId} = attrs;
    this.fetch(attrs);
    const path = controller.dirPath(dirId) ?? '';
    return m(
      '.pf-dune-graph__info',
      this.renderHeader(controller, path),
      this.renderDuneFile(controller, dirId, path),
      this.renderParent(controller),
      this.renderReveal(controller, dirId),
      m(
        Accordion,
        {multi: true},
        this.renderChildren(controller, path),
        this.renderMembers(attrs),
      ),
    );
  }

  // Starts the two eager fetches when the panel is showing a directory it
  // hasn't read yet, and asks for a redraw once they land. Called from `view`,
  // so it must be a no-op for a directory already fetched.
  //
  // The child directories are eager and the members are not: a directory's
  // branching factor is small and is the thing you navigate by, while its
  // membership is the thing that runs to six figures.
  private fetch(attrs: DirInfoPanelAttrs): void {
    const {controller, trace, dirId} = attrs;
    const key = `${dirId}|${controller.mirrorVersion}`;
    if (this.key === key) return;
    this.key = key;
    this.details = undefined;
    this.children = undefined;
    this.members = undefined;
    this.membersAsked = false;
    if (!controller.nodeMirrorReady) return;
    void dirDetails(trace.engine, dirId).then((details) => {
      if (this.key !== key) return; // selection moved on meanwhile
      this.details = details;
      controller.requestRedraw();
    });
    void childDirs(trace.engine, dirId).then((children) => {
      if (this.key !== key) return;
      this.children = children;
      controller.requestRedraw();
    });
  }

  // The directory's path, with the same build/code icon every other path in
  // the panel gets, and the `gen-rules` span's duration beside it.
  private renderHeader(
    controller: DuneGraphController,
    path: string,
  ): m.Children {
    const {icon, text} = decoratedDir(controller, path);
    return m(
      '.pf-dune-graph__info-header',
      m(
        'span.pf-dune-graph__info-main',
        m('span.pf-dune-graph__chip.pf-dune-graph__chip--dir', 'dir'),
        icon,
        m(
          'span.pf-dune-graph__info-title',
          {title: dirPathLabel(path)},
          m(
            'span.pf-dune-graph__info-title-text',
            m('span.pf-dune-graph__info-title-bidi', text),
          ),
        ),
        this.renderStatus(),
      ),
    );
  }

  // How the `gen-rules` span ended, in the same slot a node's outcome occupies.
  //
  // Three states rather than two. A directory with no span at all is a path
  // *prefix* dune never generated rules for, which is a normal row of
  // `dune_dir` and not a missing measurement. An unfinished one is a real
  // state the pairing preserves - an interrupted build flushes a `-start` with
  // no `-finish` - and reads as a blank duration unless it is named.
  private renderStatus(): m.Children {
    const details = this.details;
    if (details === undefined) return undefined;
    const span = details.genRules;
    if (span === undefined) {
      return m(
        'span.pf-dune-graph__status',
        m(
          'span.pf-dune-graph__status-label',
          {title: 'dune generated no rules for this directory'},
          'no gen-rules',
        ),
      );
    }
    return m(
      'span.pf-dune-graph__status',
      m('span.pf-dune-graph__status-label', 'gen-rules'),
      span.finishSliceId === undefined &&
        m(
          'span.pf-dune-graph__status-label',
          {title: 'The build ended before this gen-rules did'},
          'unfinished',
        ),
      span.durNs !== undefined &&
        m('span.pf-dune-graph__status-dur', formatDurNs(span.durNs)),
      span.nOccurrences > 1 &&
        m(
          'span.pf-dune-graph__status-occ',
          {
            title: `Seen ${span.nOccurrences} times, e.g. across watch-mode iterations`,
          },
          `×${span.nOccurrences}`,
        ),
    );
  }

  // The `dune` file the span's finish recorded, or - when it recorded none -
  // the nearest ancestor directory that did, as a link to that directory.
  //
  // The fallback is not a guess: the walk is in build-directory space and each
  // row carries its own `dune_file`, so what is shown is a file some
  // `gen-rules` really named (see model/dir_explorer.ts's `dirDetailsQuery`).
  private renderDuneFile(
    controller: DuneGraphController,
    dirId: number,
    path: string,
  ): m.Children {
    const details = this.details;
    if (details === undefined) return undefined;
    const file = details.duneFile;
    if (file === undefined) {
      return m(
        '.pf-dune-graph__dir',
        m('span.pf-dune-graph__refs-empty', 'No dune file'),
      );
    }
    const {icon, text} = decorateDepPath(
      file.path,
      controller.graph.buildRoots,
    );
    // How far up the walk went, said in tree terms rather than by naming the
    // ancestor: the ancestor's path is a prefix of this one, so its own name
    // adds nothing the reader cannot already see, while the distance is the
    // part that is not on screen. Off the two paths rather than a `depth`
    // column, because the mirror answers both synchronously.
    const up = levelsUp(controller, dirId, path, file.dirId);
    return m(
      '.pf-dune-graph__dir',
      {title: file.path},
      m('span.pf-dune-graph__dir-label', 'Dune file'),
      icon,
      text,
      up !== undefined && ' via ',
      up !== undefined &&
        dirAnchor(
          controller,
          file.dirId,
          `${up} level${up === 1 ? '' : 's'} up`,
          'This directory recorded no dune file of its own; ' +
            'this is the nearest ancestor that did',
        ),
    );
  }

  private renderParent(controller: DuneGraphController): m.Children {
    const parentId = this.details?.parentId;
    if (parentId === undefined) return undefined;
    // Labelled by the relationship, not the path: the path is the header's,
    // minus its last segment, so repeating it says nothing.
    return m(
      '.pf-dune-graph__dir',
      dirAnchor(
        controller,
        parentId,
        'Parent',
        dirPathLabel(controller.dirPath(parentId) ?? ''),
      ),
    );
  }

  // The way back into the Explorer tab, which is where this directory sits in
  // the build's tree rather than on its own. The tree expands to it, which
  // takes a query per level and so is the pane's own job - all this does is
  // ask. See ARCHITECTURE.md, "Revealing a directory in the tree".
  private renderReveal(
    controller: DuneGraphController,
    dirId: number,
  ): m.Children {
    return m(
      '.pf-dune-graph__dir',
      m(Button, {
        label: 'Show in Explorer',
        icon: 'account_tree',
        compact: true,
        onclick: () => controller.revealDirInExplorer(dirId),
      }),
    );
  }

  // The child directories, compressed past runs of pass-through directories
  // exactly as the Explorer pane's are - so this lists the directories that
  // hold something rather than the next path segment.
  private renderChildren(
    controller: DuneGraphController,
    path: string,
  ): m.Children {
    const children = this.children;
    return m(
      AccordionSection,
      {
        key: 'dirs',
        summary:
          children === undefined
            ? 'Subdirectories'
            : `Subdirectories (${children.length})`,
        defaultOpen: true,
      },
      children === undefined
        ? m('.pf-dune-graph__refs-empty', 'Reading…')
        : children.length === 0
          ? m('.pf-dune-graph__refs-empty', 'None')
          : children.map((child) =>
              m(
                '.pf-dune-graph__ref',
                m(
                  'span.pf-dune-graph__ref-label',
                  childLink(controller, child, path),
                ),
              ),
            ),
    );
  }

  // The rules and deps filed directly in this directory: the count from the
  // directory's own row, the list only once asked for. One page, because the
  // count alone says whether the rest is worth going to the Explorer pane for.
  private renderMembers(attrs: DirInfoPanelAttrs): m.Children {
    const {controller} = attrs;
    const details = this.details;
    const total =
      details === undefined ? undefined : details.nRules + details.nDeps;
    return m(
      AccordionSection,
      {
        key: 'members',
        summary:
          total === undefined
            ? 'Members'
            : `Members (${total.toLocaleString()})`,
        defaultOpen: true,
      },
      total === 0
        ? m('.pf-dune-graph__refs-empty', 'None')
        : total === undefined
          ? undefined
          : !this.membersAsked
            ? m(
                '.pf-dune-graph__refs-empty',
                m(Button, {
                  label: `Load ${Math.min(total, MEMBER_PAGE).toLocaleString()}\u2026`,
                  icon: 'list',
                  onclick: () => this.loadMembers(attrs),
                }),
              )
            : this.renderMemberRows(controller, total),
    );
  }

  private renderMemberRows(
    controller: DuneGraphController,
    total: number,
  ): m.Children {
    const members = this.members;
    if (members === undefined) {
      return m('.pf-dune-graph__refs-empty', 'Reading…');
    }
    return [
      ...members.map((entry) =>
        m(
          '.pf-dune-graph__ref',
          m(
            'span.pf-dune-graph__ref-label',
            renderNodeCell(controller, entry.nodeId),
          ),
          renderNodeCellActions(controller, entry.nodeId),
        ),
      ),
      members.length < total &&
        m(
          '.pf-dune-graph__refs-empty',
          `Showing ${members.length.toLocaleString()} of ` +
            `${total.toLocaleString()} - the Explorer tab pages the rest.`,
        ),
    ];
  }

  private loadMembers(attrs: DirInfoPanelAttrs): void {
    const {controller, trace, dirId} = attrs;
    const key = this.key;
    this.membersAsked = true;
    void dirMembers(trace.engine, dirId, undefined, MEMBER_PAGE).then(
      (members) => {
        if (this.key !== key) return; // selection moved on meanwhile
        this.members = members;
        controller.requestRedraw();
      },
    );
  }
}

// A child directory, as a link only where there is something to link to.
// `goToDir` selects the directory's `gen-rules` span, and a directory dune
// generated no rules for has none - so on such a row the anchor would be a
// link that does nothing, which is the rule `nodeLink` already follows for a
// ref with no resolved node (see selection_info_panel.ts). A minority but a
// real one: 56 of merlin's 364 directories have no span.
function childLink(
  controller: DuneGraphController,
  child: DirEntry,
  parentPath: string,
): m.Children {
  // The same label the Explorer tree gives the row - what this directory adds
  // to the one above it, which for a compressed run of pass-through
  // directories is several segments rather than one.
  const label = dirLabel(child, parentPath);
  if (child.nGenRules === 0) return label;
  return dirAnchor(controller, child.id, label, dirPathLabel(child.path));
}

// How many levels separate `dirId` from the ancestor `fileDirId`, or undefined
// when they are the same directory. Path segments rather than a stored depth:
// the ancestor's path is always a prefix of this one (the walk is strictly
// upwards), so the difference in segment counts is the distance.
function levelsUp(
  controller: DuneGraphController,
  dirId: number,
  path: string,
  fileDirId: number,
): number | undefined {
  if (fileDirId === dirId) return undefined;
  const filePath = controller.dirPath(fileDirId);
  if (filePath === undefined) return undefined;
  return segmentCount(path) - segmentCount(filePath);
}

function segmentCount(path: string): number {
  return path === '' ? 0 : path.split('/').length;
}

// A directory path as the rest of the panel renders one. The top level has no
// path to decorate and is named rather than rendered as an empty string (see
// model/dir_tree.ts).
function decoratedDir(
  controller: DuneGraphController,
  path: string,
): {icon: m.Children; text: string} {
  if (path === '') return {icon: undefined, text: TOP_LEVEL_LABEL};
  return decorateDepPath(path, controller.graph.buildRoots);
}
