import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

export const RENDERER_PROTOCOL = 'studyapp-renderer';
export const RENDERER_ENTRY_URL = `${RENDERER_PROTOCOL}://app/index.html`;

const ALLOWED_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.png',
  '.svg',
  '.webp',
  '.woff',
  '.woff2',
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

type SchemeRegistrar = Readonly<{
  registerSchemesAsPrivileged(
    schemes: Readonly<{
      scheme: string;
      privileges: Readonly<{
        standard: boolean;
        secure: boolean;
        supportFetchAPI: boolean;
        corsEnabled: boolean;
      }>;
    }>[],
  ): void;
}>;

type ProtocolInstaller = Readonly<{
  handle(scheme: string, handler: (request: Request) => Promise<Response>): void | Promise<void>;
}>;

export const registerRendererScheme = (registrar: SchemeRegistrar): void => {
  registrar.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
      },
    },
  ]);
};

const safeDecodedPathname = (pathname: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes('\\') || decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
};

export const resolveRendererAssetPath = (
  rendererRoot: string,
  requestUrl: string,
): string | undefined => {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== `${RENDERER_PROTOCOL}:` ||
    url.hostname !== 'app' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== ''
  ) {
    return undefined;
  }

  const pathname = safeDecodedPathname(url.pathname);
  const segments = pathname?.split('/').filter(Boolean);
  if (!segments || segments.length === 0 || segments.some((segment) => segment === '..')) {
    return undefined;
  }

  const extension = extname(segments.at(-1) ?? '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return undefined;
  }

  const resolvedRoot = resolve(rendererRoot);
  const assetPath = resolve(resolvedRoot, ...segments);
  const pathFromRoot = relative(resolvedRoot, assetPath);

  if (pathFromRoot === '' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    return undefined;
  }

  return assetPath;
};

const notFound = (): Response => new Response('Not found', { status: 404 });

export const installRendererProtocol = async (
  protocolInstaller: ProtocolInstaller,
  rendererRoot: string,
): Promise<void> => {
  await protocolInstaller.handle(RENDERER_PROTOCOL, async (request) => {
    const assetPath = resolveRendererAssetPath(rendererRoot, request.url);
    if (!assetPath) {
      return notFound();
    }

    try {
      const bytes = await readFile(assetPath);
      const contentType = CONTENT_TYPES[extname(assetPath).toLowerCase()];
      if (!contentType) {
        return notFound();
      }

      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Cache-Control': assetPath.endsWith('.html') ? 'no-store' : 'public, max-age=31536000',
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return notFound();
    }
  });
};
