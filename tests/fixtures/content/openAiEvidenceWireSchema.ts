// Hand-authored wire oracle: no production schema/converter is used to derive expectations.
const uuid = {
  type: 'string',
  format: 'uuid',
  pattern:
    '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
};
const index = { type: 'integer', exclusiveMinimum: 0, maximum: 1000000 };
const position = { type: 'integer', minimum: 0, maximum: 9007199254740991 };
export const openAiEvidenceWireSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  readOnly: true,
  type: 'object',
  properties: {
    segments: {
      readOnly: true,
      maxItems: 10000,
      type: 'array',
      items: {
        readOnly: true,
        type: 'object',
        properties: {
          id: uuid,
          sourceId: uuid,
          kind: {
            type: 'string',
            enum: [
              'definition',
              'explanation',
              'example',
              'formula',
              'question',
              'answer',
              'emphasis',
              'observation',
            ],
          },
          text: { type: 'string', minLength: 1, maxLength: 20000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          locator: {
            anyOf: [
              {
                readOnly: true,
                type: 'object',
                properties: {
                  kind: { type: 'string', const: 'audio' },
                  startMs: position,
                  endMs: position,
                },
                required: ['kind', 'startMs', 'endMs'],
                additionalProperties: false,
              },
              {
                readOnly: true,
                type: 'object',
                properties: { kind: { type: 'string', const: 'document' }, page: index },
                required: ['kind', 'page'],
                additionalProperties: false,
              },
              {
                readOnly: true,
                type: 'object',
                properties: { kind: { type: 'string', const: 'slide' }, slide: index },
                required: ['kind', 'slide'],
                additionalProperties: false,
              },
              {
                readOnly: true,
                type: 'object',
                properties: {
                  kind: { type: 'string', const: 'image' },
                  x: { type: 'number', minimum: 0, maximum: 1 },
                  y: { type: 'number', minimum: 0, maximum: 1 },
                  width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                  height: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                },
                required: ['kind', 'x', 'y', 'width', 'height'],
                additionalProperties: false,
              },
              {
                readOnly: true,
                type: 'object',
                properties: {
                  kind: { type: 'string', const: 'text' },
                  startLine: index,
                  endLine: index,
                },
                required: ['kind', 'startLine', 'endLine'],
                additionalProperties: false,
              },
            ],
          },
          language: {
            anyOf: [
              { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$' },
              { type: 'null' },
            ],
          },
          uncertainty: {
            anyOf: [{ type: 'string', minLength: 1, maxLength: 2000 }, { type: 'null' }],
          },
          sessionDate: {
            anyOf: [
              {
                type: 'string',
                format: 'date',
                pattern:
                  '^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$',
              },
              { type: 'null' },
            ],
          },
        },
        required: [
          'id',
          'sourceId',
          'kind',
          'text',
          'confidence',
          'locator',
          'language',
          'uncertainty',
          'sessionDate',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['segments'],
  additionalProperties: false,
};
