export type DatabaseRuntimeConfiguration = Readonly<{
  journalMode: 'wal';
  foreignKeys: true;
  busyTimeoutMs: 5_000;
  synchronous: 'full';
}>;

export interface DatabasePort {
  close(): void;
  getRuntimeConfiguration(): DatabaseRuntimeConfiguration;
  getSchemaVersion(): number;
}
