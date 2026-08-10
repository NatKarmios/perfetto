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

import {parseJsonWithBigints} from '../../base/json_utils';

// Slice args arrive as untyped JSON (integers become bigints, see
// parseJsonWithBigints). These helpers navigate that structure defensively so a
// malformed or unexpected arg shape yields `undefined` rather than throwing.

export function parseArgsJson(json: string): unknown {
  return parseJsonWithBigints(json);
}

function getField(obj: unknown, key: string): unknown {
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

// Navigate a nested object path, e.g. getPath(args, 'dune', 'dep_outcome',
// 'rule'). Returns undefined if any segment is missing.
export function getPath(obj: unknown, ...path: readonly string[]): unknown {
  let cur = obj;
  for (const key of path) {
    cur = getField(cur, key);
    if (cur === undefined) return undefined;
  }
  return cur;
}

// Coerce an id that may arrive as a string, number, or bigint into a string.
export function asId(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
      return value.toString();
    default:
      return undefined;
  }
}

// A list of ids. Non-id entries are dropped. Returns undefined if `value` isn't
// an array (an empty/absent list simply has no args and never reaches here).
export function asIdArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(asId).filter((v): v is string => v !== undefined);
}

// A list of lists of ids (e.g. dynamic deps).
export function asIdArrayArray(
  value: unknown,
): readonly (readonly string[])[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(asIdArray)
    .filter((v): v is readonly string[] => v !== undefined);
}
