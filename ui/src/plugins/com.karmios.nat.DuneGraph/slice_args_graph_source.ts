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

import type {Engine} from '../../trace_processor/engine';
import {NUM, STR, STR_NULL} from '../../trace_processor/query_result';
import {
  asId,
  asIdArray,
  asIdArrayArray,
  getPath,
  parseArgsJson,
} from './arg_parsing';
import type {
  BuildGraph,
  DepNode,
  ForcedBy,
  GraphNode,
  RuleNode,
  GraphSource,
} from './graph';

// Slice names that encode the build graph.
export const DEP_SLICE = 'build-dep';
export const RULE_SLICE = 'exec-rule';

/**
 * A {@link GraphSource} that extracts the graph from slice args.
 *
 * Dep nodes come from "build-dep" slices; rule nodes from "exec-rule" slices.
 * Both kinds carry all their data (including a rule's static/dynamic deps) in
 * the args of the slice itself, so a single query builds the whole graph.
 */
export class SliceArgsGraphSource implements GraphSource {
  constructor(private readonly engine: Engine) {}

  get description(): string {
    return `slice args • ${DEP_SLICE} / ${RULE_SLICE}`;
  }

  async load(): Promise<BuildGraph> {
    const deps = new Map<string, DepNode>();
    const rules = new Map<string, RuleNode>();

    const result = await this.engine.query(`
      select
        s.id as sliceId,
        s.name as name,
        __intrinsic_arg_set_to_json(s.arg_set_id) as argsJson
      from slice s
      where s.name in ('${DEP_SLICE}', '${RULE_SLICE}')
    `);

    const it = result.iter({sliceId: NUM, name: STR, argsJson: STR_NULL});
    for (; it.valid(); it.next()) {
      if (it.argsJson === null) continue;
      // Event args are nested under a top-level `debug` dict, so the graph
      // keys live at `debug.dune.*`. Descend into `debug` once here and the
      // rest of the extraction navigates from there as before.
      const args = getPath(parseArgsJson(it.argsJson), 'debug');

      if (it.name === DEP_SLICE) {
        const id = asId(getPath(args, 'dune', 'dep'));
        // First occurrence wins if a dep is built more than once.
        if (id === undefined || deps.has(id)) continue;
        deps.set(id, {
          kind: 'dep',
          id,
          sliceId: it.sliceId,
          resolvedRuleId: asId(getPath(args, 'dune', 'dep_outcome', 'rule')),
          expandedDepIds: asIdArray(
            getPath(args, 'dune', 'dep_outcome', 'expanded'),
          ),
          forcedBy: parseForcedBy(args),
        });
      } else {
        const id = asId(getPath(args, 'dune', 'rule_id'));
        if (id === undefined || rules.has(id)) continue;
        rules.set(id, {
          kind: 'rule',
          id,
          sliceId: it.sliceId,
          staticDepIds: asIdArray(getPath(args, 'dune', 'deps')),
          dynamicDepIds: asIdArrayArray(getPath(args, 'dune', 'dyn_deps')),
          dir: asId(getPath(args, 'dune', 'dir')),
          targetFiles: asIdArray(getPath(args, 'dune', 'target_files')),
          targetDirs: asIdArray(getPath(args, 'dune', 'target_dirs')),
          forcedBy: parseForcedBy(args),
        });
      }
    }

    // Reverse index over both kinds.
    const bySliceId = new Map<number, GraphNode>();
    for (const dep of deps.values()) bySliceId.set(dep.sliceId, dep);
    for (const rule of rules.values()) bySliceId.set(rule.sliceId, rule);

    return {deps, rules, bySliceId};
  }
}

// Parse a node's `dune.forced_by` args into a {@link ForcedBy}. The `kind`
// selects which payload field to read; a kind whose expected payload is missing
// degrades to `UNKNOWN` (rather than a half-populated variant), and an absent /
// unrecognized kind yields undefined.
function parseForcedBy(args: unknown): ForcedBy | undefined {
  const kind = asId(getPath(args, 'dune', 'forced_by', 'kind'));
  if (kind === undefined) return undefined;
  const payload = (field: string) =>
    asId(getPath(args, 'dune', 'forced_by', field));
  switch (kind) {
    case 'RULE': {
      const rule = payload('rule');
      return rule === undefined ? {kind: 'UNKNOWN'} : {kind: 'RULE', rule};
    }
    case 'DEP': {
      const dep = payload('dep');
      return dep === undefined ? {kind: 'UNKNOWN'} : {kind: 'DEP', dep};
    }
    case 'DYNAMIC_INCLUDES': {
      const path = payload('dynamic_includes');
      return path === undefined
        ? {kind: 'UNKNOWN'}
        : {kind: 'DYNAMIC_INCLUDES', dynamicIncludes: path};
    }
    case 'GEN_RULES': {
      const path = payload('gen_rules');
      return path === undefined
        ? {kind: 'UNKNOWN'}
        : {kind: 'GEN_RULES', genRules: path};
    }
    case 'PFORM': {
      const path = payload('pform');
      return path === undefined
        ? {kind: 'UNKNOWN'}
        : {kind: 'PFORM', pform: path};
    }
    case 'CONFIGURATOR':
      return {kind: 'CONFIGURATOR'};
    case 'REQUEST':
      return {kind: 'REQUEST'};
    default:
      return {kind: 'UNKNOWN'};
  }
}
