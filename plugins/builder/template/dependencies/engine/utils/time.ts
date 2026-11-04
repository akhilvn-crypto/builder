// Times shown to people (run ids, report stamps) are Indian Standard Time. IST is a fixed UTC+05:30 offset with no
// daylight saving, so a plain offset is exact. Stored timestamps in manifests and results stay ISO UTC.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// "2026-10-19T14:00:12" for the instant 2026-10-19T08:30:12Z.
export function istIso(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19);
}

// "2026-10-19 14:00:12 IST"; '' for a missing or unparseable timestamp.
export function formatIst(iso: string): string {
  const t = Date.parse(iso);
  return iso && !Number.isNaN(t) ? `${istIso(new Date(t)).replace('T', ' ')} IST` : '';
}
