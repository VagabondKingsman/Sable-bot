import { withPrefix } from "@/lib/agent/client";

/** W3: screenshot shown on a desktop approval card, with the intended click/scroll target marked. */
export function DesktopShot({ image, mark, alt = "Ảnh màn hình desktop (:99)" }: { image: string; mark?: { x: number; y: number; w: number; h: number }; alt?: string }) {
  return (
    <div className="relative mt-2 overflow-hidden rounded-xl shadow-ring">
      <img src={withPrefix(image)} alt={alt} className="block h-auto w-full" draggable={false} />
      {mark && mark.w > 0 && mark.h > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-red-500 bg-red-500/25 ring-2 ring-white/80"
          style={{ left: `${(mark.x / mark.w) * 100}%`, top: `${(mark.y / mark.h) * 100}%` }}
        />
      )}
    </div>
  );
}
