import type { DriveName, Result, VaultPath } from '../types';
import { driveName, err, ioError, isValidVaultPath, ok, vaultPath } from '../types';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from './bytes';
import type { PathDictionary } from './path-dictionary';
import { emptyDictionary, expandPath, substitutePath } from './path-dictionary';

/**
 * objects/ storage: base64url(UTF-8(tokenized path)). A dictionary beside the
 * files supplies immutable token meanings; doubled braces carry literal braces.
 */

/** Encodes a vault path as the Drive file name that will hold it. */
/** ASCII component budget; this cannot guarantee the full local path length. */
export const MAX_DRIVE_NAME_LENGTH = 240;

export function encodePath(
  path: VaultPath,
  dictionary: PathDictionary = emptyDictionary(),
): DriveName {
  return driveName(toBase64Url(utf8Encode(substitutePath(path, dictionary))));
}

/** Preflight before any upload, rename or deletion. Never truncate a name. */
export function checkEncodedPath(path: VaultPath, dictionary: PathDictionary): Result<DriveName> {
  const name = encodePath(path, dictionary);
  if (name.length > MAX_DRIVE_NAME_LENGTH) {
    return err(
      ioError(
        `Encoded name for "${path}" is ${String(name.length)} characters (maximum ${String(MAX_DRIVE_NAME_LENGTH)}). Add a path replacement rule in settings.`,
      ),
    );
  }
  const decoded = decodePath(name, dictionary);
  if (!decoded.ok) return decoded;
  if (decoded.value !== path) return err(ioError(`Path encoding did not round-trip: ${path}`));
  return ok(name);
}

/**
 * Decodes a Drive file name back to a vault path.
 *
 * Rejects unknown tokens, malformed encodings and unsafe expanded paths.
 * Does NOT guarantee the path exists locally or that the file is readable.
 */
export function decodePath(
  name: string,
  dictionary: PathDictionary = emptyDictionary(),
): Result<VaultPath> {
  const encoded = name;
  const bytes = fromBase64Url(encoded);
  if (bytes === null || toBase64Url(bytes) !== encoded) {
    return err(ioError(`Drive file name is not base64url: ${JSON.stringify(name)}`));
  }

  const text = utf8Decode(bytes);
  // Detect malformed UTF-8 without rejecting an actual U+FFFD in a file name.
  if (toBase64Url(utf8Encode(text)) !== encoded) {
    return err(ioError(`Drive file name does not decode to text: ${JSON.stringify(name)}`));
  }
  const expanded = expandPath(text, dictionary);
  if (!expanded.ok) return expanded;
  const decoded = expanded.value;
  if (!isValidVaultPath(decoded)) {
    return err(ioError(`Drive file name decodes to an unusable path: ${JSON.stringify(decoded)}`));
  }

  return ok(vaultPath(decoded));
}
