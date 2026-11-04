// Display order of tests in the reports: by test ID (natural order, so TC-2 comes before TC-10), then by browser project.
// Execution order is different (the plan runs sign-in and own-session tests where they must, not where their ID falls), so a
// report that is read by ID keeps each test's execution position as a small note instead (FinalTest.runOrder).

export function compareTestIds(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

// A sorted copy; ties keep their incoming order (Array.prototype.sort is stable).
export function sortedByTestId<T extends { testId: string; project: string }>(list: readonly T[]): T[] {
  return [...list].sort((x, y) => compareTestIds(x.testId, y.testId) || x.project.localeCompare(y.project));
}

// "ran 2nd of 5"; null for a test that never ran (it has no position).
export function runOrderNote(runOrder: number | null | undefined, executed: number): string | null {
  if (runOrder == null) return null;
  return `ran ${ordinal(runOrder)} of ${executed}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}
