interface VideoTileProps {
  label?: string;
  empty?: boolean;
  emptyText?: string;
}

export function VideoTile({ label, empty = false, emptyText }: VideoTileProps) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-sc-xl border border-sc-border bg-[var(--sc-hero-deep)] shadow-sc-md">
      <div className="sc-tile-placeholder absolute inset-0" />
      {empty ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="t-h3 text-sc-text">
            {emptyText ?? "Waiting for the second participant…"}
          </p>
          <p className="t-body-sm text-sc-text-2">
            Share the room link to invite them.
          </p>
        </div>
      ) : null}
      {label ? (
        <div className="absolute bottom-3 left-3 rounded-sc-full bg-black/55 px-3 py-1 text-[13px] font-medium text-white backdrop-blur">
          {label}
        </div>
      ) : null}
    </div>
  );
}
