import { useState } from 'react';

const PLAYER_WIDTHS = [0.7, 0.85, 1];

export default function YouTubeVideoPlayer({ video, onClose }) {
  const [isFloating, setIsFloating] = useState(false);
  const [widthIndex, setWidthIndex] = useState(1);

  if (!video?.videoId) return null;

  const player = (
    <section
      aria-label={`YouTube player: ${video.title}`}
      className={isFloating
        ? 'fixed bottom-4 right-4 z-[100] w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-slate-600 bg-slate-950 p-3 shadow-2xl'
        : 'space-y-2 rounded-xl border border-slate-700 bg-slate-900/70 p-3'}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="min-w-0 flex-1 truncate text-xs font-bold text-white">{video.title}</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setWidthIndex((index) => Math.max(0, index - 1))}
            disabled={widthIndex === 0}
            aria-label="Zoom out video"
            className="rounded-md border border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            Zoom -
          </button>
          <button
            type="button"
            onClick={() => setWidthIndex((index) => Math.min(PLAYER_WIDTHS.length - 1, index + 1))}
            disabled={widthIndex === PLAYER_WIDTHS.length - 1}
            aria-label="Zoom in video"
            className="rounded-md border border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            Zoom +
          </button>
          <button
            type="button"
            onClick={() => setIsFloating((floating) => !floating)}
            aria-pressed={isFloating}
            className="rounded-md border border-teal-500/40 px-2 py-1 text-[11px] font-semibold text-teal-100 hover:bg-teal-500/10"
          >
            {isFloating ? 'Dock player' : 'Float player'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close video player"
            className="rounded-md border border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </div>
      <div className="flex justify-center">
        <div
          className="aspect-video max-w-full overflow-hidden rounded-lg bg-black"
          style={{ width: `${PLAYER_WIDTHS[widthIndex] * 100}%` }}
        >
          <iframe
            key={video.videoId}
            title={`YouTube video: ${video.title}`}
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.videoId)}?controls=1&fs=1&playsinline=1&rel=0`}
            className="h-full w-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-400">
        Use YouTube&apos;s player controls for sound and available quality settings. Full screen and Picture-in-Picture are available when supported by the video and browser.
      </p>
    </section>
  );

  return player;
}
