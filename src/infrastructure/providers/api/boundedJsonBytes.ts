import type { JsonValue } from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';

/** Count an already-owned JSON snapshot without allocating its serialized representation. */
export const countBoundedJsonBytes = (value: JsonValue, ceiling: number): number => {
  let total = 0;
  let entries = 0;
  const add = (bytes: number): void => {
    total += bytes;
    if (total > ceiling)
      throw new AppError(
        'PROVIDER_REQUEST_TOO_LARGE',
        APP_ERROR_MESSAGES.PROVIDER_REQUEST_TOO_LARGE,
      );
  };
  const string = (text: string): void => {
    add(2);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) add(2);
      else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
      ) {
        add(4);
        index += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (item: JsonValue, depth: number): void => {
    entries += 1;
    if (depth > 64 || entries > 100_000)
      throw new AppError(
        'PROVIDER_REQUEST_TOO_LARGE',
        APP_ERROR_MESSAGES.PROVIDER_REQUEST_TOO_LARGE,
      );
    if (typeof item === 'string') string(item);
    else if (item === null) add(4);
    else if (typeof item === 'boolean') add(item ? 4 : 5);
    else if (typeof item === 'number') add(String(item).length);
    else if (Array.isArray(item)) {
      add(2);
      for (let index = 0; index < item.length; index += 1) {
        if (index !== 0) add(1);
        visit(item[index] as JsonValue, depth + 1);
      }
    } else {
      add(2);
      let index = 0;
      for (const key of Object.keys(item)) {
        if (index++ !== 0) add(1);
        string(key);
        add(1);
        visit((item as Record<string, JsonValue>)[key] as JsonValue, depth + 1);
      }
    }
  };
  visit(value, 1);
  return total;
};
