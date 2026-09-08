import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  installRendererProtocol,
  RENDERER_ENTRY_URL,
  RENDERER_PROTOCOL,
  registerRendererScheme,
  resolveRendererAssetPath,
} from '../../../src/main/rendererProtocol';

describe('renderer protocol', () => {
  it('registers a secure standard scheme before Electron becomes ready', () => {
    const registerSchemesAsPrivileged = vi.fn();

    registerRendererScheme({ registerSchemesAsPrivileged });

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
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
  });

  it('resolves only allowlisted assets under the renderer root', () => {
    const root = resolve('C:\\app', 'renderer');

    expect(resolveRendererAssetPath(root, RENDERER_ENTRY_URL)).toBe(resolve(root, 'index.html'));
    expect(resolveRendererAssetPath(root, `${RENDERER_PROTOCOL}://app/assets/app-123.js`)).toBe(
      resolve(root, 'assets', 'app-123.js'),
    );
    expect(resolveRendererAssetPath(root, 'https://app/index.html')).toBeUndefined();
    expect(
      resolveRendererAssetPath(root, `${RENDERER_PROTOCOL}://other/index.html`),
    ).toBeUndefined();
    expect(
      resolveRendererAssetPath(root, `${RENDERER_PROTOCOL}://app/..%5Csecret.txt`),
    ).toBeUndefined();
    expect(
      resolveRendererAssetPath(root, `${RENDERER_PROTOCOL}://app/assets/secret.exe`),
    ).toBeUndefined();
  });

  it('serves a known renderer file and returns 404 for rejected URLs', async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const handle = vi.fn(async (_scheme: string, installed: typeof handler) => {
      handler = installed;
    });
    const rendererRoot = resolve(process.cwd(), 'src/renderer');

    await installRendererProtocol({ handle }, rendererRoot);

    const response = await handler?.(new Request(RENDERER_ENTRY_URL));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('text/html; charset=utf-8');
    await expect(response?.text()).resolves.toContain('<!doctype html>');

    const rejected = await handler?.(new Request(`${RENDERER_PROTOCOL}://app/file.exe`));
    expect(rejected?.status).toBe(404);
  });
});
