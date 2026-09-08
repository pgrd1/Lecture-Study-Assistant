import process from 'node:process';

const mode = process.argv[2];
const numericArgument = Number.parseInt(process.argv[3] ?? '', 10);

const writeBytes = (stream, count) => {
  let remaining = count;
  const writeChunk = () => {
    if (remaining <= 0) {
      stream.end();
      return;
    }
    const size = Math.min(1_024, remaining);
    remaining -= size;
    stream.write(Buffer.alloc(size, 0x61), () => setImmediate(writeChunk));
  };
  writeChunk();
};

switch (mode) {
  case 'echo-stdin-json': {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => process.stdout.end(Buffer.concat(chunks)));
    break;
  }
  case 'sleep':
    setTimeout(
      () => process.exit(0),
      Number.isSafeInteger(numericArgument) ? numericArgument : 10_000,
    );
    break;
  case 'stdout-bytes':
    writeBytes(process.stdout, Number.isSafeInteger(numericArgument) ? numericArgument : 0);
    break;
  case 'stderr-bytes':
    writeBytes(process.stderr, Number.isSafeInteger(numericArgument) ? numericArgument : 0);
    break;
  case 'exit-code':
    process.exit(Number.isSafeInteger(numericArgument) ? numericArgument : 1);
    break;
  default:
    process.exit(64);
}
