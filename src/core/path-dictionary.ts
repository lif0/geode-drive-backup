import type { Result } from '../types';
import { err, ioError, ok } from '../types';
import { utf8Decode, utf8Encode } from './bytes';

export const DICTIONARY_NAME = '__geode_dictionary.json';
export const DICTIONARY_BACKUP_NAME = '__geode_dictionary.previous.json';
export const MAX_DICTIONARY_BYTES = 8 * 1024 * 1024;

export interface PathRule {
  readonly id: number;
  readonly text: string;
  readonly enabled: boolean;
}

export interface PathDictionary {
  readonly version: 1;
  readonly rules: readonly PathRule[];
}

export function emptyDictionary(): PathDictionary {
  return { version: 1, rules: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never discard malformed rules: they could change the meaning of a backup. */
export function readDictionary(value: unknown): Result<PathDictionary> {
  if (!isRecord(value) || value['version'] !== 1 || !Array.isArray(value['rules'])) {
    return err(ioError('Invalid or unsupported path dictionary. Expected version 1 and rules.'));
  }
  const rules: PathRule[] = [];
  const ids = new Set<number>();
  const texts = new Set<string>();
  for (const raw of value['rules']) {
    if (!isRecord(raw)) return err(ioError('Invalid path dictionary rule.'));
    const id = raw['id'];
    const text = raw['text'];
    const enabled = raw['enabled'];
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      typeof text !== 'string' ||
      text.length === 0 ||
      text.includes('\0') ||
      text !== text.normalize('NFC') ||
      utf8Decode(utf8Encode(text)) !== text ||
      typeof enabled !== 'boolean'
    ) {
      return err(
        ioError('Rules need a positive integer ID, nonempty NFC text and an enabled flag.'),
      );
    }
    if (ids.has(id) || texts.has(text))
      return err(ioError('Duplicate ID or text in the path dictionary.'));
    ids.add(id);
    texts.add(text);
    rules.push({ id, text, enabled });
  }
  return ok({ version: 1, rules: rules.sort((a, b) => a.id - b.id) });
}

/** Existing meanings are immutable; remote-only rules are retained, never deleted. */
export function mergeDictionaries(
  local: PathDictionary,
  remote: PathDictionary,
): Result<PathDictionary> {
  const rules = new Map(remote.rules.map((rule) => [rule.id, rule]));
  for (const rule of local.rules) {
    const existing = rules.get(rule.id);
    if (existing !== undefined && existing.text !== rule.text) {
      return err(
        ioError(
          `Dictionary ID ${String(rule.id)} has a different meaning on Drive. Nothing was published.`,
        ),
      );
    }
    rules.set(rule.id, rule);
  }
  return readDictionary({ version: 1, rules: [...rules.values()] });
}

export function addDictionaryRule(
  dictionary: PathDictionary,
  text: string,
): Result<PathDictionary> {
  const id = dictionary.rules.reduce((largest, rule) => Math.max(largest, rule.id), 0) + 1;
  return readDictionary({
    version: 1,
    rules: [...dictionary.rules, { id, text: text.normalize('NFC'), enabled: true }],
  });
}

export function serializeDictionary(dictionary: PathDictionary): string {
  return JSON.stringify(dictionary, null, 2) + '\n';
}

/** Scan original text once; never match generated tokens again. */
export function substitutePath(path: string, dictionary: PathDictionary): string {
  const rules = dictionary.rules
    .filter((rule) => rule.enabled)
    .sort((a, b) => b.text.length - a.text.length || a.id - b.id);
  let result = '';
  for (let offset = 0; offset < path.length;) {
    const rule = rules.find((candidate) => path.startsWith(candidate.text, offset));
    if (rule !== undefined) {
      result += `{${String(rule.id)}}`;
      offset += rule.text.length;
    } else {
      const char = path.charAt(offset);
      result += char === '{' || char === '}' ? char + char : char;
      offset += 1;
    }
  }
  return result;
}

/** Expansions are literal, including braces; disabled rules still decode. */
export function expandPath(text: string, dictionary: PathDictionary): Result<string> {
  const rules = new Map(dictionary.rules.map((rule) => [rule.id, rule.text]));
  let result = '';
  for (let offset = 0; offset < text.length;) {
    const char = text.charAt(offset);
    if (char !== '{' && char !== '}') {
      result += char;
      offset += 1;
    } else if (text.charAt(offset + 1) === char) {
      result += char;
      offset += 2;
    } else {
      const token = /^\{([1-9][0-9]*)\}/.exec(text.slice(offset));
      if (char !== '{' || token === null)
        return err(ioError('Malformed dictionary token or unescaped brace.'));
      const replacement = rules.get(Number(token[1]));
      if (replacement === undefined)
        return err(
          ioError(`Unknown dictionary token ${token[0]}. Restore the correct dictionary.`),
        );
      result += replacement;
      offset += token[0].length;
    }
    if (result.length > 65536) return err(ioError('Decoded path exceeds the safety limit.'));
  }
  return ok(result);
}
