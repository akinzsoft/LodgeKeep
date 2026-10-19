'use strict';

/**
 * Runs `attempt` again when MySQL aborted it as a deadlock victim (`ER_LOCK_DEADLOCK`). The victim's transaction was rolled
 * back whole, so running the same idempotent mutation again is safe; anything else is rethrown at once. Bounded, so a
 * real problem is not hidden: after the last attempt the deadlock error itself is thrown.
 */
async function retryOnDeadlock(attempt, { attempts = 4 } = {}) {
  for (let tried = 1; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (error?.code !== 'ER_LOCK_DEADLOCK' || tried >= attempts) throw error;
    }
  }
}

module.exports = { retryOnDeadlock };
