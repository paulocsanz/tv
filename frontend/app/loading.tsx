function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/10 ${className}`} />;
}

function RowSkeleton() {
  return (
    <div className="mt-8 px-4 sm:px-8">
      <Bar className="mb-3 h-5 w-40" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-[2/3] w-32 shrink-0 sm:w-40">
            <Bar className="h-full w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="pb-12">
      <Bar className="h-[45vh] w-full rounded-none sm:h-[55vh]" />
      <RowSkeleton />
      <RowSkeleton />
      <RowSkeleton />
    </div>
  );
}
