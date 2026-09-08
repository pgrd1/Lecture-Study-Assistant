import { createRequire } from 'node:module';

// saxes 6.0.0's bundled declarations fail TS7 strict generic constraints.
// Keep the direct pinned runtime, with only the documented namespace API used here.
export type SaxesTagNS = Readonly<{
  uri: string;
  local: string;
  attributes: Readonly<Record<string, Readonly<{ uri: string; local: string; value: string }>>>;
}>;
interface Parser {
  on(event: 'opentag' | 'closetag', handler: (tag: SaxesTagNS) => void): void;
  on(event: 'doctype' | 'error', handler: () => void): void;
  write(value: string): Parser;
  close(): void;
}
// Electron's main bundle is CommonJS; the metadata worker remains native ESM.
const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
export const SaxesParser = (
  require('saxes') as { SaxesParser: new (options: { xmlns: true }) => Parser }
).SaxesParser;
