import { z } from 'zod';
import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';
import { ManagedMarkdownDocumentSchema } from '../../shared/contracts/obsidianWorkspace';
import { renderProperties } from './propertyRenderer';

const Revision = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u);
const Body = z
  .string()
  .max(100_000)
  .refine(
    (value) =>
      !/[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) &&
      !Array.from(value).some(
        (character) => /\p{Cc}/u.test(character) && !['\n', '\r', '\t'].includes(character),
      ),
  );
const Title = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value));
const Callout = z
  .strictObject({
    type: z.enum(['important', 'warning', 'example', 'question', 'summary']),
    title: Title,
    body: Body,
  })
  .readonly();
export type ObsidianCallout = z.infer<typeof Callout>;

// CommonMark's complete inline-tag grammar. Requiring the closing delimiter keeps
// incomplete comparison tokens such as $a<b + c$ intact. Only replace the opener
// so nested HTML-looking text in attribute values is checked independently too.
const COMPLETE_TAG =
  /<(?=(?:\/[A-Za-z][A-Za-z0-9-]*[\t\n ]*|[A-Za-z][A-Za-z0-9-]*(?:[\t\n ]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[\t\n ]*=[\t\n ]*(?:[^\t\n "'=<>`]+|'[^']*'|"[^"]*"))?)*[\t\n ]*\/?)>)/gu;

// These finite CommonMark block tags can start raw HTML without a closing '>'.
// EOF counts as a line ending because the renderer appends a boundary newline.
// Recognize leading quote/list markers as well as ordinary line starts.
const BLOCK_START =
  /(^[\t ]*(?:(?:>|[-+*]|[0-9]{1,9}[.)])[\t ]*)*)<(\/?(?:script|pre|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul))(?=[\t\n />]|$)/gimu;

const neutralizeHtml = (value: string): string =>
  value
    .replace(/<(?=!--|!\[CDATA\[|![A-Z]|\?)/gu, '&lt;')
    .replace(BLOCK_START, '$1&lt;$2')
    .replace(COMPLETE_TAG, '&lt;');
const normalizeBody = (value: string): string =>
  neutralizeHtml(Body.parse(value).replace(/\r\n?/gu, '\n'));

/** Every body line stays in the quote, including blank and nested quote lines. */
export const renderCallout = (input: unknown): string => {
  assertBoundedPipelineJson(input);
  const callout = Callout.parse(input);
  const body = normalizeBody(callout.body);
  return [
    `> [!${callout.type}] ${neutralizeHtml(callout.title)}`,
    ...(body === '' ? [] : body.split('\n').map((line) => (line === '' ? '>' : `> ${line}`))),
  ].join('\n');
};

/** Initial candidate only; later merge code owns preservation of actual user bytes. */
export const renderMarkdownDocument = (input: unknown, generationRevision: unknown): string => {
  const document = ManagedMarkdownDocumentSchema.parse(input);
  const revision = Revision.parse(generationRevision);
  const sections = document.generatedSections.map((section) =>
    [
      `<!-- study-assistant:generated:start section="${section.id}" revision="${revision}" -->`,
      normalizeBody(section.markdown).replace(/\n+$/u, ''),
      '<!-- study-assistant:generated:end -->',
    ].join('\n'),
  );
  return `${[
    renderProperties(document.properties),
    ...sections,
    '<!-- study-assistant:user:start -->\n사용자 메모를 이 영역에 작성하세요.\n<!-- study-assistant:user:end -->',
  ].join('\n\n')}\n`;
};
