import { describe, it, expect } from 'vitest';
import { startBackgroundDevicePoll } from '../index.js';

type Status = 'pending' | 'expired' | 'done';

// A synchronous scheduler: instead of real timers, queue the callbacks and let
// the test drain them one microtask-flush at a time. This exercises the real
// recursion/stop logic of startBackgroundDevicePoll deterministically.
function makeDriver() {
  const queue: Array<() => void> = [];
  const schedule = (fn: () => void) => {
    queue.push(fn);
  };
  const drain = async (maxTicks = 20) => {
    let ticks = 0;
    while (queue.length && ticks < maxTicks) {
      const fn = queue.shift()!;
      fn();
      // let the async tick body (poll + reschedule) settle
      await Promise.resolve();
      await Promise.resolve();
      ticks++;
    }
    return ticks;
  };
  return { schedule, drain, queue };
}

const flow = () =>
  ({ deviceCode: 'dc', userCode: 'UC', verifyUrl: 'https://x/device', pollInterval: 5000, deadline: 0, polling: false }) as never;

describe('startBackgroundDevicePoll', () => {
  it('stops immediately once a poll returns done (no further reschedule)', async () => {
    const { schedule, drain, queue } = makeDriver();
    let calls = 0;
    const poll = async () => {
      calls++;
      return 'done' as Status;
    };
    startBackgroundDevicePoll(flow(), poll, () => true, schedule);
    await drain();
    expect(calls).toBe(1);
    expect(queue.length).toBe(0); // did not reschedule after done
  });

  it('keeps polling while pending, then stops on done', async () => {
    const { schedule, drain, queue } = makeDriver();
    const seq: Status[] = ['pending', 'pending', 'done'];
    let i = 0;
    const poll = async () => seq[i++];
    startBackgroundDevicePoll(flow(), poll, () => true, schedule);
    await drain();
    expect(i).toBe(3); // polled through pending → pending → done
    expect(queue.length).toBe(0);
  });

  it('stops on expired without rescheduling', async () => {
    const { schedule, drain, queue } = makeDriver();
    let calls = 0;
    const poll = async () => {
      calls++;
      return 'expired' as Status;
    };
    startBackgroundDevicePoll(flow(), poll, () => true, schedule);
    await drain();
    expect(calls).toBe(1);
    expect(queue.length).toBe(0);
  });

  it('does nothing when the flow was superseded (isCurrent=false)', async () => {
    const { schedule, drain } = makeDriver();
    let calls = 0;
    const poll = async () => {
      calls++;
      return 'pending' as Status;
    };
    startBackgroundDevicePoll(flow(), poll, () => false, schedule);
    await drain();
    expect(calls).toBe(0); // tick short-circuits before polling
  });

  it('survives a throwing poll and keeps going until it resolves', async () => {
    const { schedule, drain } = makeDriver();
    const seq: Array<Status | 'throw'> = ['throw', 'pending', 'done'];
    let i = 0;
    const poll = async () => {
      const s = seq[i++];
      if (s === 'throw') throw new Error('network blip');
      return s;
    };
    // must not reject; must reach 'done'
    startBackgroundDevicePoll(flow(), poll, () => true, schedule);
    await drain();
    expect(i).toBe(3);
  });
});
