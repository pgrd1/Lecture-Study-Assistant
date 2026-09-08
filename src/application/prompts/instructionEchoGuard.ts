import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';

const invalid = () => new TypeError('PRIVATE_INSTRUCTION_ECHO');
// NFKC, case and non-letter/digit folding defeat escaped Markdown, punctuation,
// invisible separators and arbitrary spacing; this is an echo gate, not a paraphrase detector.
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toUpperCase()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
};

/** Caller supplies the actual instruction layers captured for this request, never source data.
 * All failures are generic: private text must not enter errors, receipts or logs. */
export const assertNoInstructionEcho = (value: unknown, instructions: readonly string[]): void => {
  try {
    assertBoundedPipelineJson({ value, instructions });
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(instructions) ||
    instructions.length > 128 ||
    instructions.some((text) => typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024)
  )
    throw invalid();
  const fields = strings(value).map(normalize);
  const rendered = fields.join('');
  for (const instruction of instructions as readonly string[]) {
    const fragments = instruction.split(/[\r\n]+|(?<=[.!?。！？])\s+/u);
    if (
      [instruction, ...fragments].some((fragment) => {
        const part = normalize(fragment);
        if (!part) return false;
        // Even short generic instructions cannot be returned as an entire field.
        if (fields.includes(part)) return true;
        // Distinctive short codes remain private within prose or across output fields;
        // ordinary short directives ("Be brief.") may occur incidentally in a longer answer.
        const distinctive =
          (/\p{L}/u.test(part) && /\p{N}/u.test(part)) ||
          /private|secret|code|key|token|password|비공개|비밀|코드|키|토큰|암호|비밀번호/u.test(
            part,
          ) ||
          /[:=]/u.test(fragment.normalize('NFKC'));
        return (part.length >= 12 || distinctive) && rendered.includes(part);
      })
    )
      throw invalid();
  }
};
