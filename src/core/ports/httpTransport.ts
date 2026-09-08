export type HttpTransportRequestInit = Readonly<{
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: string;
  redirect: 'error';
  cache: 'no-store';
  signal: AbortSignal;
}>;

export interface HttpTransport {
  request(url: string, init: HttpTransportRequestInit): Promise<Response>;
}

export type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

export const createFetchHttpTransport = (
  fetchImplementation: FetchImplementation = (input, init) => globalThis.fetch(input, init),
): HttpTransport =>
  Object.freeze({
    request: (url: string, init: HttpTransportRequestInit) => fetchImplementation(url, init),
  });
