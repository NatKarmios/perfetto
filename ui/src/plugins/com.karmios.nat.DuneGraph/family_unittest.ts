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

import {describe, expect, test} from 'vitest';
import {resolvingDeps} from './family';
import {dep, rule, testGraph} from './graph_test_helper';

// Which dep each rule is filed under - the one part of the family index that
// needs no query engine. The rest of it is positions, which come from the
// core's own layout query and are verified against a real trace instead.
describe('resolvingDeps', () => {
  const fixture = testGraph([
    dep('a/x.cmi', {resolvedRule: 'r1'}),
    dep('alias/x.cmi', {resolvedRule: 'r1'}),
    dep('a/y.ml', {isSource: true}),
    rule('r1', {dir: 'a', targetFiles: ['x.cmi']}),
    rule('r2', {dir: 'a', targetFiles: ['z.cmi']}),
  ]);
  const {graph} = fixture;
  const id = (name: string) => fixture.id(name);
  const pairs = (names: readonly string[]) =>
    [...resolvingDeps(graph, names.map(id))].map(([r, d]) => [r, d]);

  test('pairs a rule with the dep that resolves to it', () => {
    expect(pairs(['a/x.cmi', 'r1'])).toEqual([[id('r1'), id('a/x.cmi')]]);
  });

  test('picks one dep when several resolve to the same rule', () => {
    // Both aliases are selected, but a rule belongs to one family - the first
    // dep in selection order wins.
    expect(pairs(['alias/x.cmi', 'a/x.cmi', 'r1'])).toEqual([
      [id('r1'), id('alias/x.cmi')],
    ]);
  });

  test('ignores a dep whose rule is not selected', () => {
    // There would be no row at the far end of the link.
    expect(pairs(['a/x.cmi'])).toEqual([]);
  });

  test('ignores a rule nothing selected resolves to', () => {
    expect(pairs(['a/x.cmi', 'r1', 'r2'])).toEqual([[id('r1'), id('a/x.cmi')]]);
  });

  test('ignores deps that resolve to something other than a rule', () => {
    expect(pairs(['a/y.ml', 'r1'])).toEqual([]);
  });
});
