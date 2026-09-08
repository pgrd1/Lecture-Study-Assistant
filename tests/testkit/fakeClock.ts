export class FakeClock {
  #milliseconds: number;

  constructor(initialTime = '2026-09-01T00:00:00.000Z') {
    const milliseconds = Date.parse(initialTime);
    if (!Number.isFinite(milliseconds)) {
      throw new RangeError('INVALID_FAKE_CLOCK_TIME');
    }
    this.#milliseconds = milliseconds;
  }

  now(): string {
    return new Date(this.#milliseconds).toISOString();
  }

  async advance(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('INVALID_FAKE_CLOCK_ADVANCE');
    }
    this.#milliseconds += milliseconds;
  }
}
