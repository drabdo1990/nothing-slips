// app/loading.tsx

/** Skeleton that mirrors the real layout, so nothing jumps when data lands. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your day</span>

      <div className="flex flex-col gap-2">
        <div className="h-4 w-32 animate-pulse rounded bg-mist" />
        <div className="h-7 w-56 animate-pulse rounded bg-mist" />
      </div>

      <div className="h-12 animate-pulse rounded-lg bg-mist" />

      <div className="flex flex-col gap-2">
        <div className="h-4 w-24 animate-pulse rounded bg-mist" />
        <div className="h-24 animate-pulse rounded-[var(--radius-card)] bg-mist" />
      </div>

      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-20 animate-pulse rounded-[var(--radius-card)] bg-mist" />
        ))}
      </div>
    </div>
  );
}
