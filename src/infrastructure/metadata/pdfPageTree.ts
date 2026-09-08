import {
  PDFArray,
  type PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRef,
} from 'pdf-lib';
import { METADATA_LIMITS } from '../../shared/contracts/sourceMetadata';
import { invalid, limit } from './metadataError';

const entry = (dict: PDFDict, name: string): PDFObject | undefined =>
  dict.get(PDFName.of(name), true);
const isType = (context: PDFContext, dict: PDFDict, name: string): boolean =>
  context.lookup(entry(dict, 'Type')) === PDFName.of(name);

const branch = (context: PDFContext, dict: PDFDict): readonly [PDFArray, number] => {
  const count = context.lookup(entry(dict, 'Count'));
  const kids = context.lookup(entry(dict, 'Kids'));
  if (!(count instanceof PDFNumber) || !(kids instanceof PDFArray)) return invalid();
  const declared = count.asNumber();
  if (!Number.isSafeInteger(declared) || declared < 1 || kids.size() < 1) return invalid();
  if (declared > METADATA_LIMITS.pages || kids.size() > METADATA_LIMITS.pdfTreeFanout)
    return limit();
  return [kids, declared];
};

/** Traverse supported parser objects, never the library's recursive getPages/Count shortcut. */
const completeTreeCount = (context: PDFContext, root: PDFRef): number => {
  const refs = new Set<string>();
  const dictionaries = new WeakSet<PDFDict>();
  let leaves = 0;
  const visit = (object: PDFObject, parent: PDFRef | undefined, depth: number): number => {
    if (depth > METADATA_LIMITS.pdfTreeDepth || refs.size >= METADATA_LIMITS.pdfTreeNodes)
      return limit();
    if (!(object instanceof PDFRef) || refs.has(object.tag)) return invalid();
    const dict = context.lookup(object);
    if (!(dict instanceof PDFDict) || dictionaries.has(dict)) return invalid();
    refs.add(object.tag);
    dictionaries.add(dict);
    const actualParent = entry(dict, 'Parent');
    if (
      parent
        ? !(actualParent instanceof PDFRef) || actualParent.tag !== parent.tag
        : actualParent !== undefined
    )
      return invalid();
    if (isType(context, dict, 'Page')) {
      if (!parent || entry(dict, 'Kids') !== undefined || entry(dict, 'Count') !== undefined)
        return invalid();
      if (++leaves > METADATA_LIMITS.pages) return limit();
      return 1;
    }
    if (!isType(context, dict, 'Pages')) return invalid();
    const [kids, declared] = branch(context, dict);
    let measured = 0;
    for (let i = 0; i < kids.size(); i++) measured += visit(kids.get(i), object, depth + 1);
    if (measured !== declared) return invalid();
    return measured;
  };
  return visit(root, undefined, 1);
};

/** Pure in-memory load; source/heap/deadline bounds are enforced by the terminable worker. */
export const countPdfPageTree = async (bytes: Uint8Array): Promise<number> => {
  const document = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
    throwOnInvalidObject: true,
    capNumbers: false,
  });
  const { context } = document;
  const catalog = context.lookup(context.trailerInfo.Root);
  if (!(catalog instanceof PDFDict) || !isType(context, catalog, 'Catalog')) return invalid();
  const root = entry(catalog, 'Pages');
  if (!(root instanceof PDFRef)) return invalid();
  return completeTreeCount(context, root);
};
