'use strict';

/**
 * Recurring-expense due-date logic — pure functions, directly testable with
 * no database, plus the one function that actually touches the database
 * (`postDueExpenseForSchedule`, trx-based, called from the daily sweep).
 *
 * `addMonthsClamped` generalizes `billing/service.js`'s `addOneMonth`
 * (which is always "+1 month, same day") to an arbitrary month count
 * (3 for quarterly, 12 for annually) and an arbitrary target day, with the
 * identical clamping technique: a target day beyond the destination
 * month's real length (Feb 29 in a non-leap year, day 31 in a 30-day
 * month) clamps down to that month's last real day, rather than
 * overflowing into the month after.
 */

function daysInMonth(year, monthIndexZeroBased) {
  // Day 0 of the FOLLOWING month is the last real day of this one — a
  // plain, DST-agnostic UTC calendar computation.
  return new Date(Date.UTC(year, monthIndexZeroBased + 1, 0)).getUTCDate();
}

/** `dateString` ('YYYY-MM-DD') + `monthsToAdd` months, landing on `targetDay` clamped to the destination month's real length. */
function addMonthsClamped(dateString, monthsToAdd, targetDay) {
  const [year, month] = dateString.split('-').map(Number);
  const zeroBasedMonth = month - 1 + monthsToAdd;
  const targetYear = year + Math.floor(zeroBasedMonth / 12);
  const targetMonthIndex = ((zeroBasedMonth % 12) + 12) % 12;
  const clampedDay = Math.min(targetDay, daysInMonth(targetYear, targetMonthIndex));
  const iso = new Date(Date.UTC(targetYear, targetMonthIndex, clampedDay)).toISOString();
  return iso.slice(0, 10);
}

const FREQUENCY_MONTHS = { monthly: 1, quarterly: 3, annually: 12 };

/**
 * The next date on or after `fromDate` matching the schedule's own cadence.
 * `inclusive: true` means "if `fromDate` itself already matches, return it
 * unchanged" — used both for a brand-new schedule's initial due date
 * (starting today should be due today, not one period later) and for
 * `resumeRecurringExpenseSchedule`'s "recompute forward from today"
 * re-anchor.
 */
function computeNextDueDate({ fromDate, frequency, dayOfMonth, dayOfWeek, inclusive = false }) {
  if (frequency === 'weekly') {
    const cursor = new Date(`${fromDate}T00:00:00Z`);
    for (let i = inclusive ? 0 : 1; i <= 7; i += 1) {
      const candidate = new Date(cursor);
      candidate.setUTCDate(candidate.getUTCDate() + i);
      if (candidate.getUTCDay() === dayOfWeek) return candidate.toISOString().slice(0, 10);
    }
    // Unreachable — every day-of-week appears within any 7-day window.
    return fromDate;
  }

  const monthsToAdd = FREQUENCY_MONTHS[frequency];
  if (!monthsToAdd) throw new Error(`Unknown recurrence frequency "${frequency}".`);

  const [year, month] = fromDate.split('-').map(Number);
  const clampedThisMonth = Math.min(dayOfMonth, daysInMonth(year, month - 1));
  const thisMonthCandidate = `${fromDate.slice(0, 8)}${String(clampedThisMonth).padStart(2, '0')}`;
  if (inclusive && thisMonthCandidate === fromDate) return fromDate;
  if (!inclusive && thisMonthCandidate > fromDate) return thisMonthCandidate;
  if (inclusive && thisMonthCandidate >= fromDate) return thisMonthCandidate;

  return addMonthsClamped(fromDate, monthsToAdd, dayOfMonth);
}

/** Pure: is this schedule due to fire? `<=`, not `===` — an overdue schedule (server down, sweep missed) still fires once next examined, never silently skipped. */
function isScheduleDue({ schedule, businessDate }) {
  return schedule.status === 'active' && String(schedule.next_due_date) <= String(businessDate);
}

/**
 * The one function in this file that touches the database — called from
 * the daily sweep (`src/jobs/expense-schedules.js`) inside a transaction
 * that has already locked `recurring_expense_schedules` for the property
 * via a plain read of the DUE rows; this function re-locks and re-checks
 * the ONE schedule it's given before doing anything, so it's safe to call
 * even if the caller's own initial read is now stale.
 */
async function postDueExpenseForSchedule({ trx, recordExpense, schedule, businessDate }) {
  const locked = await trx.table('recurring_expense_schedules').where({ id: schedule.id }).forUpdate().first();
  if (!locked || !isScheduleDue({ schedule: locked, businessDate })) {
    return { posted: false };
  }

  const expense = await recordExpense({
    trx,
    expenseCategoryId: locked.expense_category_id,
    description: locked.description,
    payee: locked.payee,
    amount: locked.amount,
    currency: locked.currency,
    paymentMethod: locked.payment_method,
    businessDate,
    userId: null,
    source: 'recurring',
    recurringExpenseScheduleId: locked.id,
  });

  // Advances from the schedule's OWN prior next_due_date, never from
  // `businessDate` — see file header.
  const nextDueDate = computeNextDueDate({
    fromDate: locked.next_due_date,
    frequency: locked.frequency,
    dayOfMonth: locked.day_of_month,
    dayOfWeek: locked.day_of_week,
  });

  await trx.table('recurring_expense_schedules').where({ id: locked.id }).update({ next_due_date: nextDueDate, last_posted_date: businessDate });

  return { posted: true, expenseId: expense.id, nextDueDate };
}

module.exports = { addMonthsClamped, computeNextDueDate, isScheduleDue, postDueExpenseForSchedule };
