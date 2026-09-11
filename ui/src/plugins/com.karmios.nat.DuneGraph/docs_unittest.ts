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

/**
 * The docs are split in two - README.md for using the plugin, ARCHITECTURE.md
 * for working on it - and the code points into both by section title. This is
 * the test that keeps those pointers honest, because nothing else can: a
 * renamed heading leaves a comment naming a section that no longer exists, and
 * the only way to find out is to follow one.
 *
 * Two things are checked, the second nearly free once the first is written:
 *
 * - every `README.md, "X"` / `ARCHITECTURE.md, "X"` in the plugin's sources
 *   names a heading of that file;
 * - every `[text](#anchor)` inside the two files resolves to one of its own
 *   headings, so the Contents lists cannot rot either;
 * - AGENTS.md still names all three of the documents it exists to route to.
 *
 * A pointer may name a *prefix* of a heading, but only one the heading then
 * breaks off with a separator - several headings carry a trailing file list
 * (`Timing - \`sql/lifecycle_sql.ts\``) or a second clause that a comment has no
 * reason to repeat. A bare prefix test would let a heading grow a suffix and
 * still pass, which is exactly the rename this test exists to catch.
 *
 * Sources and docs are read through Vite's `import.meta.glob` rather than
 * `node:fs`, for the reason layering_unittest.ts gives.
 */

const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const docs = import.meta.glob('./*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// `README.md, "The load path"` and the same over a line break, where the
// continuation carries a `//` or ` * ` comment marker. The `**` is optional
// because several of these sit inside a bolded lead sentence.
const POINTER = /(README|ARCHITECTURE)\.md,\s*(?:\*\*)?"([^"]{1,120})"/g;

// A markdown link to an anchor within the same file.
const ANCHOR_LINK = /\]\(#([a-z0-9-]+)\)/g;

function docFor(name: string): string {
  const text = docs[`./${name}.md`];
  expect(text, `${name}.md is missing`).toBeDefined();
  return text;
}

// Comment markers and the line breaks around them, so a title split across two
// comment lines reads as one string.
function normalizeTitle(raw: string): string {
  return raw
    .replace(/\n\s*(?:\/\/|\*)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whether `pointer` names `heading`: the whole of it, or the part before the
// separator that introduces a file list or a second clause.
function names(heading: string, pointer: string): boolean {
  if (heading === pointer) return true;
  if (!heading.startsWith(pointer)) return false;
  return /^(?:,| [-\u2013\u2014])/.test(heading.slice(pointer.length));
}

function headingsOf(text: string): string[] {
  return [...text.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1].trim());
}

/**
 * GitHub's heading-to-anchor rule, as far as these files exercise it: lowercase,
 * drop anything that is not a word character, space or hyphen, then hyphenate.
 * Backticks and commas go; an em dash goes with the punctuation and leaves the
 * spaces around it, which is why the collapse of repeated hyphens matters.
 */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

describe('doc pointers', () => {
  test('every pointer in the sources names a real heading', () => {
    const headings = new Map(
      ['README', 'ARCHITECTURE'].map((n) => [n, headingsOf(docFor(n))]),
    );

    const broken: string[] = [];
    let found = 0;
    for (const [path, text] of Object.entries(sources)) {
      for (const match of text.matchAll(POINTER)) {
        found++;
        const title = normalizeTitle(match[2]);
        const candidates = headings.get(match[1])!;
        if (!candidates.some((h) => names(h, title))) {
          broken.push(`${path}: ${match[1]}.md, "${title}"`);
        }
      }
    }

    expect(broken).toEqual([]);
    // The pointers are the point, so an accidentally-empty sweep - a changed
    // comment style, a glob that stopped matching - has to fail rather than
    // pass vacuously.
    expect(found).toBeGreaterThan(20);
  });

  test.each(['README', 'ARCHITECTURE'])(
    '%s.md has no dangling anchor links',
    (name) => {
      const text = docFor(name);
      const anchors = new Set(headingsOf(text).map(slug));
      const dangling = [...text.matchAll(ANCHOR_LINK)]
        .map((m) => m[1])
        .filter((a) => !anchors.has(a));
      expect(dangling).toEqual([]);
    },
  );

  test('the docs point at each other', () => {
    expect(docFor('README')).toContain('ARCHITECTURE.md');
    expect(docFor('ARCHITECTURE')).toContain('README.md');
    // AGENTS.md is the map: it has to name all three or it is not one.
    const agents = docFor('AGENTS');
    for (const name of ['README.md', 'ARCHITECTURE.md', 'UPSTREAM.md']) {
      expect(agents, `AGENTS.md does not mention ${name}`).toContain(name);
    }
  });
});
