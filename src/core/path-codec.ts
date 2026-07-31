import type { DriveName, Result, VaultPath } from '../types';
import { driveName, err, ioError, isValidVaultPath, ok, vaultPath } from '../types';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from './bytes';

/**
 * Vault path to Drive file name, and back.
 *
 * Drive storage is flat: no folder hierarchy is mirrored, so the whole path has
 * to live in the file name. base64url keeps every path — including Cyrillic,
 * emoji, spaces and slashes — inside the characters Drive names allow.
 *
 * The path is deliberately NOT stored in appProperties: those cap at about 124
 * bytes per key/value pair, which a non-ASCII path overflows.
 */

/** Encodes a vault path as the Drive file name that will hold it. */
export function encodePath(path: VaultPath): DriveName {
  return driveName(toBase64Url(utf8Encode(path)));
}

/**
 * Decodes a Drive file name back to a vault path.
 *
 * Fails on anything that is not base64url of a valid path, which is how
 * `__keycheck` and any foreign file in the folder get filtered out.
 * Does NOT guarantee the path exists locally or that the file is readable.
 */
export function decodePath(name: string): Result<VaultPath> {
  const bytes = fromBase64Url(name);
  if (bytes === null) {
    return err(ioError(`Drive file name is not base64url: ${JSON.stringify(name)}`));
  }

  const decoded = utf8Decode(bytes);
  // utf8Decode substitutes U+FFFD rather than throwing, so re-encoding is the
  // only way to notice that the bytes were not valid utf-8 to begin with.
  if (decoded.includes('�')) {
    return err(ioError(`Drive file name does not decode to text: ${JSON.stringify(name)}`));
  }
  if (!isValidVaultPath(decoded)) {
    return err(ioError(`Drive file name decodes to an unusable path: ${JSON.stringify(decoded)}`));
  }

  return ok(vaultPath(decoded));
}
