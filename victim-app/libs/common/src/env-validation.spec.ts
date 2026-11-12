import {
  parseMemoryGaugeIntervalMs,
  validateMemoryGaugeInterval,
} from './env-validation';

describe('parseMemoryGaugeIntervalMs', () => {
  it('defaults to 1000 for undefined and empty string', () => {
    expect(parseMemoryGaugeIntervalMs(undefined)).toBe(1000);
    expect(parseMemoryGaugeIntervalMs('')).toBe(1000);
  });

  it('accepts positive integers, trimming whitespace', () => {
    expect(parseMemoryGaugeIntervalMs('250')).toBe(250);
    expect(parseMemoryGaugeIntervalMs(' 500 ')).toBe(500);
  });

  it.each(['0', '-5', '1.5', 'abc', 'NaN', 'Infinity', '1e3', '0x10', '007', '   ', '9007199254740993'])(
    'rejects %p naming the variable',
    (raw) => {
      expect(() => parseMemoryGaugeIntervalMs(raw)).toThrow(
        /MEMORY_GAUGE_INTERVAL_MS/,
      );
    },
  );
});

describe('validateMemoryGaugeInterval', () => {
  const original = process.env.MEMORY_GAUGE_INTERVAL_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.MEMORY_GAUGE_INTERVAL_MS;
    else process.env.MEMORY_GAUGE_INTERVAL_MS = original;
    jest.restoreAllMocks();
  });

  it('logs and exits with code 1 on invalid value', () => {
    process.env.MEMORY_GAUGE_INTERVAL_MS = 'nope';
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    validateMemoryGaugeInterval();
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls[0][0]).toMatch(
      /^\[Bootstrap\] MEMORY_GAUGE_INTERVAL_MS .*Exiting\.$/,
    );
  });

  it('does not exit on valid or unset value', () => {
    delete process.env.MEMORY_GAUGE_INTERVAL_MS;
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    validateMemoryGaugeInterval();
    expect(exit).not.toHaveBeenCalled();
  });
});
