/** utf8-bom-crlf: remove one leading UTF-8 BOM, replace CRLF only, preserve lone CR. */
export const normalizeUtf8Source = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
